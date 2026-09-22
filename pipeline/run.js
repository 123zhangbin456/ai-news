import { join } from 'node:path';
import {
  PIPELINE_DIR, readJSON, log, dayKey, hourOf, isoBeijing, hoursAgo, sleep,
} from './util.js';
import { fetchAll, checkSources } from './fetch.js';
import { dedupe } from './dedupe.js';
import { passesAiFilter, enrich, paperRank, scoreItem } from './classify.js';
import {
  loadSeen, saveSeen, appendItems, loadUnpushed, markPushed, patchItems,
  rebuildIndex, loadRecentTitles, digestSentToday, markDigestSent, rebuildCatalog,
} from './store.js';
import { buildItemCard, buildDigestCard, buildHealthCard, send } from './notify.js';
import { interpretItems, ensureInterpreted, SYSTEM_AI, SYSTEM_MILITARY } from './interpret.js';

const ARXIV_STORE_CAP = 20;   // 每次运行最多入库的论文数，防止 450 篇淹没其他新闻
const REALTIME_CAP = 8;       // 单次实时推送上限，避免突发新闻刷屏

const INTERPRET_SYSTEM = {
  ai: SYSTEM_AI,
  military: SYSTEM_MILITARY,
};

/** Cursor 分类用更低门槛，其余用全局阈值 */
function pushFloor(item, config) {
  if (item.category === 'Cursor') return config.cursorPushThreshold ?? 40;
  return config.pushThreshold;
}

function isPushable(item, config) {
  if (config.arxiv?.neverPushRealtime && item.source?.type === 'paper') return false;
  return item.score >= pushFloor(item, config);
}

/** Cursor 存量按当前规则重算分，避免旧分在衰减策略改过之后一直卡在线以下 */
function withFreshCursorScore(item, rules, now) {
  if (item.category !== 'Cursor' && item.source?.type !== 'cursor') return item;
  return { ...item, score: scoreItem(item, rules, now) };
}

/* ---------- 参数与主题 ---------- */

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const kv = Object.fromEntries(
    argv.filter((a) => a.includes('=')).map((a) => a.replace(/^--/, '').split('='))
  );
  return {
    dryRun: flags.has('--dry-run'),
    checkOnly: flags.has('--check-sources'),
    mode: kv.mode ?? 'auto',
    topic: kv.topic ?? 'ai',
  };
}

/** 从 domains.json 解析主题配置 */
function resolveTopic(domains, topicId) {
  for (const domain of domains.domains ?? []) {
    for (const topic of domain.topics ?? []) {
      if (topic.id === topicId && topic.channel !== 'policy') {
        return {
          domainId: domain.id,
          topicId: topic.id,
          name: topic.name,
          sourcesFile: topic.sourcesFile ?? (topicId === 'ai' ? 'sources.json' : `${topicId}-sources.json`),
          rulesFile: topic.rulesFile ?? (topicId === 'ai' ? 'rules.json' : `${topicId}-rules.json`),
          digestTitle: topic.digestTitle ?? `${topic.name}简报`,
          pushThreshold: topic.pushThreshold,
          enableCursor: topicId === 'ai',
          enableArxiv: topicId === 'ai',
        };
      }
    }
  }
  if (topicId === 'ai') {
    return {
      domainId: 'tech',
      topicId: 'ai',
      name: 'AI',
      sourcesFile: 'sources.json',
      rulesFile: 'rules.json',
      digestTitle: 'AI 晨报',
      enableCursor: true,
      enableArxiv: true,
    };
  }
  throw new Error(`未知主题：${topicId}（请在 domains.json 配置 channel=ai 的主题）`);
}

/**
 * auto 模式下按北京时间自己判断该干什么，本地随时手动跑也不会出错。
 *
 * 晨报窗口留到 8 点：GitHub Actions 的定时任务常有十几分钟排队延迟，
 * 卡死在 6 点整会导致某些天的晨报直接丢失。发过就不再发，靠状态文件保证。
 */
async function resolveMode(mode, topicId) {
  if (mode !== 'auto') return mode;
  const h = hourOf();
  if (h < 6 || h >= 21) return 'night';
  if (h < 8 && !(await digestSentToday(topicId))) return 'morning';
  return 'daytime';
}

/* ---------- 源可用性自检 ---------- */

async function runCheck(sources, config, sourcesFile) {
  log.step('逐个探测所有新闻源…\n');
  const results = await checkSources(sources, config);

  for (const r of results.sort((a, b) => Number(a.ok) - Number(b.ok))) {
    const state = r.ok ? '可用' : '失败';
    const detail = r.ok ? `${String(r.count).padStart(3)} 条  ${r.sample ?? ''}`.slice(0, 80) : r.error;
    log[r.ok ? 'ok' : 'warn'](`${r.name.padEnd(20)} ${state}  ${detail}`);
  }

  const broken = results.filter((r) => !r.ok);
  log.step(`${results.length} 个源，${results.length - broken.length} 个可用，${broken.length} 个失败。`);
  if (broken.length) {
    log.info(`失败的源可以在 pipeline/${sourcesFile} 里换地址或把 enabled 设为 false。`);
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const config = await readJSON(join(PIPELINE_DIR, 'config.json'));
  const domains = await readJSON(join(PIPELINE_DIR, 'domains.json'));
  const topic = resolveTopic(domains, args.topic);
  const rules = await readJSON(join(PIPELINE_DIR, topic.rulesFile));
  const { sources } = await readJSON(join(PIPELINE_DIR, topic.sourcesFile));
  const topicId = topic.topicId;

  // 军事等主题可单独降低推送线
  if (typeof topic.pushThreshold === 'number') {
    config.pushThreshold = topic.pushThreshold;
  }

  // 军事等主题关闭 arXiv / Cursor 特例
  if (!topic.enableArxiv) {
    config.arxiv = { ...(config.arxiv ?? {}), enabled: false, neverPushRealtime: true, maxPerDigest: 0 };
  }

  const runConfig = {
    ...config,
    interpretSystem: INTERPRET_SYSTEM[topicId] ?? SYSTEM_AI,
  };

  if (args.checkOnly) return runCheck(sources, config, topic.sourcesFile);

  const mode = await resolveMode(args.mode, topicId);
  const now = new Date();
  log.step(
    `主题：${topic.name}（${topicId}）  运行模式：${mode}` +
    `${args.dryRun ? '（dry-run，不写盘不推送）' : ''}  北京时间 ${isoBeijing(now)}`
  );

  /* 1. 抓取 */
  log.step('抓取新闻源');
  const { items: raw, newlyBroken } = await fetchAll(sources, config, { dryRun: args.dryRun });

  /* 2. 过滤：过期、主题关键词、论文限流 */
  const activeSources = new Set(sources.filter((s) => s.enabled !== false).map((s) => s.id));
  let pool = raw.filter((item) => {
    if (!activeSources.has(item.source.id)) return false;
    const maxAge = topic.enableCursor && item.source.type === 'cursor'
      ? (config.cursorMaxAgeHours ?? config.maxAgeHours)
      : config.maxAgeHours;
    if (item.publishedAt && hoursAgo(item.publishedAt, now) > maxAge) return false;
    if (item.source.type === 'paper' && !config.arxiv?.enabled) return false;
    return passesAiFilter(item, rules);
  });

  let papers = [];
  if (topic.enableArxiv) {
    papers = pool
      .filter((i) => i.source.type === 'paper')
      .map((i) => ({ item: i, rank: paperRank(i, rules) }))
      .filter((p) => p.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, ARXIV_STORE_CAP)
      .map((p) => p.item);
    pool = [...pool.filter((i) => i.source.type !== 'paper'), ...papers];
  } else {
    pool = pool.filter((i) => i.source.type !== 'paper');
  }
  log.info(`抓到 ${raw.length} 条，过滤后剩 ${pool.length} 条（其中论文 ${papers.length} 条）`);

  /* 3. 去重 */
  log.step('去重');
  const seen = await loadSeen(config.seenRetentionDays, topicId);
  const recentTitles = await loadRecentTitles(3, topicId);
  const { fresh, stats } = dedupe(pool, {
    seenIds: new Set(Object.keys(seen)),
    recentTitles,
    threshold: config.titleSimilarityThreshold,
  });
  log.info(
    `重复链接 ${stats.bySeenUrl} 条，旧闻回声 ${stats.byRecentTitle} 条，` +
    `同事件合并 ${stats.merged} 条 → 新增 ${fresh.length} 条`
  );

  if (fresh.length === 0 && newlyBroken.length === 0 && mode === 'night') {
    log.step('静默期且没有新内容，结束。');
    return;
  }

  /* 4. 分类打分 */
  const enriched = enrich(fresh, rules, now).map((item) => ({
    id: item.id,
    title: item.title,
    url: item.canonicalUrl ?? item.url,
    summary: item.summary,
    source: {
      id: item.source.id,
      name: item.source.name,
      weight: item.source.weight,
      type: item.source.type,
    },
    lang: item.source.lang,
    domain: topic.domainId,
    topic: topicId,
    publishedAt: isoBeijing(item.publishedAt ? new Date(item.publishedAt) : now),
    fetchedAt: isoBeijing(now),
    category: item.category,
    keywords: item.keywords,
    confidence: item.confidence,
    score: item.score,
    paperRank: item.paperRank,
    related: item.related ?? [],
    pushed: false,
  }));

  const byCategory = enriched.reduce((acc, i) => ({ ...acc, [i.category]: (acc[i.category] ?? 0) + 1 }), {});
  log.info(Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join('  ') || '（无新增）');

  if (args.dryRun) {
    log.step('dry-run 预览（按重要度排序）');
    for (const item of [...enriched].sort((a, b) => b.score - a.score).slice(0, 20)) {
      console.log(`  [${String(item.score).padStart(3)}] ${item.category}  ${item.title}`);
      console.log(`        ${item.source.name}  ${item.keywords.join('/')}`);
    }
    return;
  }

  /* 5. 中文解读 */
  const interpreted = await interpretItems(enriched, runConfig);

  /* 6. 入库 */
  const touchedDays = await appendItems(interpreted, topicId);
  await saveSeen(seen, interpreted.map((i) => i.id), topicId);
  await rebuildIndex(rules, [...new Set([...touchedDays, dayKey(now)])], topicId);
  await rebuildCatalog(domains);
  if (interpreted.length) log.ok(`已写入 ${interpreted.length} 条到 ${touchedDays.join('、')}`);

  /* 7. 推送 */
  const notifyOpts = {
    webhook: process.env.FEISHU_WEBHOOK,
    secret: process.env.FEISHU_SECRET,
    retry: config.notifyRetry,
    dryRun: args.dryRun,
  };
  const ctx = { topicId, rules, runConfig, digestTitle: topic.digestTitle, enableCursor: topic.enableCursor };

  if (mode === 'night') {
    log.step('静默期，已入库不推送。');
  } else if (mode === 'morning') {
    await pushDigest(config, notifyOpts, now, ctx);
  } else {
    const generalBacklog = await loadUnpushed(24, topicId);
    const cursorBacklog = topic.enableCursor
      ? await loadUnpushed(config.cursorMaxAgeHours ?? 336, topicId)
      : [];
    const backlog = [...generalBacklog, ...cursorBacklog]
      .map((i) => withFreshCursorScore(i, rules, now))
      .filter((i) => isPushable(i, config));
    const map = new Map();
    for (const item of [...interpreted, ...backlog]) map.set(item.id, item);
    await pushRealtime(config, notifyOpts, [...map.values()], ctx);
  }

  if (newlyBroken.length) {
    await send(buildHealthCard(newlyBroken), { ...notifyOpts, label: `${topic.name}源健康告警` });
  }

  log.step('完成。');
}

/** 推送前补齐解读，并把结果写回 data，网页端也能看到 */
async function withInterpretPersisted(items, ctx) {
  const done = await ensureInterpreted(items, ctx.runConfig);
  const patches = done
    .filter((i) => i.interpret?.headline)
    .map((i) => ({ id: i.id, interpret: i.interpret }));
  if (patches.length) await patchItems(patches, ctx.topicId);
  return done;
}

/** 白天：只推重要度达标的 */
async function pushRealtime(config, opts, candidates, ctx) {
  let picked = candidates
    .filter((i) => isPushable(i, config))
    .sort((a, b) => b.score - a.score)
    .slice(0, REALTIME_CAP);

  if (picked.length === 0) {
    const cursorTip = ctx.enableCursor ? ` / Cursor≥${config.cursorPushThreshold ?? 40}` : '';
    log.step(`没有达到推送线的内容（≥${config.pushThreshold}${cursorTip}），本轮不打扰。`);
    return;
  }

  picked = await withInterpretPersisted(picked, ctx);

  log.step(`实时推送 ${picked.length} 条`);
  const sent = [];
  for (const item of picked) {
    const ok = await send(buildItemCard(item), { ...opts, label: item.interpret?.headline || item.title });
    if (ok) sent.push(item.id);
    await sleep(300);
  }
  await markPushed(sent, ctx.topicId);
}

/** 早上 6 点：把整夜攒的一次性给出 */
async function pushDigest(config, opts, now, ctx) {
  const pending = await loadUnpushed(30, ctx.topicId);
  const sorted = pending.sort((a, b) => {
    if (a.source.type === 'paper' !== (b.source.type === 'paper')) {
      return a.source.type === 'paper' ? 1 : -1;
    }
    return b.score - a.score;
  });

  const papers = sorted.filter((i) => i.source.type === 'paper').slice(0, config.arxiv?.maxPerDigest ?? 0);
  const news = sorted.filter((i) => i.source.type !== 'paper');
  let digest = [...news, ...papers].slice(0, config.digestMaxItems);

  digest = await withInterpretPersisted(digest, {
    ...ctx,
    runConfig: {
      ...ctx.runConfig,
      maxInterpretPerRun: Math.min(config.digestMaxItems, config.maxInterpretPerRun ?? 25),
    },
  });

  log.step(`晨报：${digest.length} 条（新闻 ${news.length}，论文 ${papers.length}）`);
  const card = buildDigestCard(digest, {
    dateLabel: `${Number(dayKey(now).slice(5, 7))}月${Number(dayKey(now).slice(8, 10))}日`,
    maxItems: config.digestMaxItems,
    title: ctx.digestTitle,
  });

  const ok = await send(card, { ...opts, label: ctx.digestTitle });
  if (ok) {
    await markPushed(pending.map((i) => i.id), ctx.topicId);
    await markDigestSent(ctx.topicId);
  }
}

main().catch((err) => {
  log.error(`运行中断：${err.message}`);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
