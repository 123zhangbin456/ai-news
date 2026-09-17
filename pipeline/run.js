import { join } from 'node:path';
import {
  PIPELINE_DIR, readJSON, log, dayKey, hourOf, isoBeijing, hoursAgo, sleep,
} from './util.js';
import { fetchAll, checkSources } from './fetch.js';
import { dedupe } from './dedupe.js';
import { passesAiFilter, enrich, paperRank } from './classify.js';
import {
  loadSeen, saveSeen, appendItems, loadUnpushed, markPushed,
  rebuildIndex, loadRecentTitles, digestSentToday, markDigestSent,
} from './store.js';
import { buildItemCard, buildDigestCard, buildHealthCard, send } from './notify.js';

const ARXIV_STORE_CAP = 20;   // 每次运行最多入库的论文数，防止 450 篇淹没其他新闻
const REALTIME_CAP = 8;       // 单次实时推送上限，避免突发新闻刷屏

/** Cursor 分类用更低门槛，其余用全局阈值 */
function pushFloor(item, config) {
  if (item.category === 'Cursor') return config.cursorPushThreshold ?? 40;
  return config.pushThreshold;
}

function isPushable(item, config) {
  if (config.arxiv.neverPushRealtime && item.source?.type === 'paper') return false;
  return item.score >= pushFloor(item, config);
}

/* ---------- 参数与模式 ---------- */

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const kv = Object.fromEntries(
    argv.filter((a) => a.includes('=')).map((a) => a.replace(/^--/, '').split('='))
  );
  return {
    dryRun: flags.has('--dry-run'),
    checkOnly: flags.has('--check-sources'),
    mode: kv.mode ?? 'auto',
  };
}

/**
 * auto 模式下按北京时间自己判断该干什么，本地随时手动跑也不会出错。
 *
 * 晨报窗口留到 8 点：GitHub Actions 的定时任务常有十几分钟排队延迟，
 * 卡死在 6 点整会导致某些天的晨报直接丢失。发过就不再发，靠状态文件保证。
 */
async function resolveMode(mode) {
  if (mode !== 'auto') return mode;
  const h = hourOf();
  if (h < 6 || h >= 21) return 'night';
  if (h < 8 && !(await digestSentToday())) return 'morning';
  return 'daytime';
}

/* ---------- 源可用性自检 ---------- */

async function runCheck(sources, config) {
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
    log.info('失败的源可以在 pipeline/sources.json 里换地址或把 enabled 设为 false。');
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const config = await readJSON(join(PIPELINE_DIR, 'config.json'));
  const rules = await readJSON(join(PIPELINE_DIR, 'rules.json'));
  const { sources } = await readJSON(join(PIPELINE_DIR, 'sources.json'));

  if (args.checkOnly) return runCheck(sources, config);

  const mode = await resolveMode(args.mode);
  const now = new Date();
  log.step(`运行模式：${mode}${args.dryRun ? '（dry-run，不写盘不推送）' : ''}  北京时间 ${isoBeijing(now)}`);

  /* 1. 抓取 */
  log.step('抓取新闻源');
  const { items: raw, newlyBroken } = await fetchAll(sources, config, { dryRun: args.dryRun });

  /* 2. 过滤：过期、非 AI 内容、论文限流 */
  const activeSources = new Set(sources.filter((s) => s.enabled !== false).map((s) => s.id));
  let pool = raw.filter((item) => {
    if (!activeSources.has(item.source.id)) return false;
    const maxAge = item.source.type === 'cursor'
      ? (config.cursorMaxAgeHours ?? config.maxAgeHours)
      : config.maxAgeHours;
    if (item.publishedAt && hoursAgo(item.publishedAt, now) > maxAge) return false;
    if (item.source.type === 'paper' && !config.arxiv.enabled) return false;
    return passesAiFilter(item, rules);
  });

  const papers = pool
    .filter((i) => i.source.type === 'paper')
    .map((i) => ({ item: i, rank: paperRank(i, rules) }))
    .filter((p) => p.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, ARXIV_STORE_CAP)
    .map((p) => p.item);

  pool = [...pool.filter((i) => i.source.type !== 'paper'), ...papers];
  log.info(`抓到 ${raw.length} 条，过滤后剩 ${pool.length} 条（其中论文 ${papers.length} 条）`);

  /* 3. 去重 */
  log.step('去重');
  const seen = await loadSeen(config.seenRetentionDays);
  const recentTitles = await loadRecentTitles(3);
  const { fresh, stats } = dedupe(pool, {
    seenIds: new Set(Object.keys(seen)),
    recentTitles,
    threshold: config.titleSimilarityThreshold,
  });
  log.info(
    `重复链接 ${stats.bySeenUrl} 条，旧闻回声 ${stats.byRecentTitle} 条，` +
    `同事件合并 ${stats.merged} 条 → 新增 ${fresh.length} 条`
  );

  // 晨报和白天推送都可能要处理"已入库但还没推过"的存量；
  // 没有新增也不能提前退出，否则 webhook 配晚了的高分新闻会永远卡在库里。
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
    publishedAt: item.publishedAt ? isoBeijing(new Date(item.publishedAt)) : isoBeijing(now),
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
  log.info(Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join('  '));

  if (args.dryRun) {
    log.step('dry-run 预览（按重要度排序）');
    for (const item of [...enriched].sort((a, b) => b.score - a.score).slice(0, 20)) {
      console.log(`  [${String(item.score).padStart(3)}] ${item.category}  ${item.title}`);
      console.log(`        ${item.source.name}  ${item.keywords.join('/')}`);
    }
    return;
  }

  /* 5. 入库 */
  const touchedDays = await appendItems(enriched);
  await saveSeen(seen, enriched.map((i) => i.id));
  await rebuildIndex(rules, [...new Set([...touchedDays, dayKey(now)])]);
  if (enriched.length) log.ok(`已写入 ${enriched.length} 条到 ${touchedDays.join('、')}`);

  /* 6. 推送 */
  const notifyOpts = {
    webhook: process.env.FEISHU_WEBHOOK,
    secret: process.env.FEISHU_SECRET,
    retry: config.notifyRetry,
    dryRun: args.dryRun,
  };

  if (mode === 'night') {
    log.step('静默期，已入库不推送。');
  } else if (mode === 'morning') {
    await pushDigest(config, notifyOpts, now);
  } else {
    // 本轮新条目 + 过去 24 小时内达标却还没推过的存量，合并去重后一起推
    const backlog = (await loadUnpushed(24)).filter((i) => isPushable(i, config));
    const pool = new Map();
    for (const item of [...enriched, ...backlog]) pool.set(item.id, item);
    await pushRealtime(config, notifyOpts, [...pool.values()]);
  }

  if (newlyBroken.length) {
    await send(buildHealthCard(newlyBroken), { ...notifyOpts, label: '源健康告警' });
  }

  log.step('完成。');
}

/** 白天：只推重要度达标的，且不含论文；Cursor 分类用更低门槛 */
async function pushRealtime(config, opts, candidates) {
  const picked = candidates
    .filter((i) => isPushable(i, config))
    .sort((a, b) => b.score - a.score)
    .slice(0, REALTIME_CAP);

  if (picked.length === 0) {
    log.step(`没有达到推送线的内容（AI≥${config.pushThreshold} / Cursor≥${config.cursorPushThreshold ?? 40}），本轮不打扰。`);
    return;
  }

  log.step(`实时推送 ${picked.length} 条`);
  const sent = [];
  for (const item of picked) {
    const ok = await send(buildItemCard(item), { ...opts, label: item.title });
    if (ok) sent.push(item.id);
    await sleep(300); // 飞书机器人限流
  }
  await markPushed(sent);
}

/** 早上 6 点：把整夜攒的一次性给出 */
async function pushDigest(config, opts, now) {
  const pending = await loadUnpushed(30);
  const sorted = pending.sort((a, b) => {
    if (a.source.type === 'paper' !== (b.source.type === 'paper')) {
      return a.source.type === 'paper' ? 1 : -1; // 论文永远排最后
    }
    return b.score - a.score;
  });

  // 论文单独限额，不占用普通新闻的位置
  const papers = sorted.filter((i) => i.source.type === 'paper').slice(0, config.arxiv.maxPerDigest);
  const news = sorted.filter((i) => i.source.type !== 'paper');
  const digest = [...news, ...papers];

  log.step(`晨报：${digest.length} 条（新闻 ${news.length}，论文 ${papers.length}）`);
  const card = buildDigestCard(digest, {
    dateLabel: `${Number(dayKey(now).slice(5, 7))}月${Number(dayKey(now).slice(8, 10))}日`,
    maxItems: config.digestMaxItems,
  });

  const ok = await send(card, { ...opts, label: 'AI 晨报' });
  if (ok) {
    // 晨报是汇总推送，未挤进卡片的条目也算已处理，否则明天会重复出现
    await markPushed(pending.map((i) => i.id));
    await markDigestSent();
  }
}

main().catch((err) => {
  log.error(`运行中断：${err.message}`);
  process.exitCode = 1;
});
