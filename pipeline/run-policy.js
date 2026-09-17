import { join } from 'node:path';
import {
  PIPELINE_DIR, readJSON, log, dayKey, isoBeijing, hoursAgo, sleep,
} from './util.js';
import { fetchPolicyItems } from './policy-fetch.js';
import {
  loadSeen, saveSeen, appendItems, loadUnpushed, markPushed,
  rebuildIndex, rebuildCatalog,
} from './store.js';
import { buildPolicyCard, send } from './notify.js';

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  return { dryRun: flags.has('--dry-run') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await readJSON(join(PIPELINE_DIR, 'policy-sources.json'));
  const domains = await readJSON(join(PIPELINE_DIR, 'domains.json'));
  const notifyCfg = await readJSON(join(PIPELINE_DIR, 'config.json'));
  const topic = cfg.topic || 'migrant';
  const now = new Date();

  log.step(`政策频道：国家政策 / 农民工${args.dryRun ? '（dry-run）' : ''}  ${isoBeijing(now)}`);
  log.info('模式：仅官方 RSS + 关键词过滤；不抓正文、不解读、不存摘要。');

  const items = await fetchPolicyItems(cfg);
  log.info(`关键词命中 ${items.length} 条`);

  const seen = await loadSeen(90, topic);
  const fresh = items
    .filter((i) => !seen[i.id])
    .map((i) => ({
      ...i,
      publishedAt: i.publishedAt ? isoBeijing(new Date(i.publishedAt)) : isoBeijing(now),
      fetchedAt: isoBeijing(now),
    }));

  log.info(`去重后新增 ${fresh.length} 条`);

  if (args.dryRun) {
    for (const item of fresh.slice(0, 20)) {
      console.log(`  [${item.keywords.join(',')}] ${item.title}`);
      console.log(`      ${item.url}`);
    }
    return;
  }

  if (fresh.length === 0) {
    await rebuildCatalog(domains);
    log.step('没有新的公开政策，结束。');
    return;
  }

  const touched = await appendItems(fresh, topic);
  await saveSeen(seen, fresh.map((i) => i.id), topic);
  await rebuildIndex({ categories: [{ name: '政策公开', icon: '📜' }] }, touched, topic);
  await rebuildCatalog(domains);
  log.ok(`已写入 ${fresh.length} 条到 ${touched.join('、')}`);

  // 有新增就推送：标题 + 跳转官网，不做解读
  const notifyOpts = {
    webhook: process.env.FEISHU_WEBHOOK,
    secret: process.env.FEISHU_SECRET,
    retry: notifyCfg.notifyRetry,
    dryRun: false,
  };

  // 也带上未推送存量（24h），避免上次推送失败漏掉
  const pending = await loadUnpushed(48, topic);
  const pool = new Map();
  for (const item of [...fresh, ...pending]) pool.set(item.id, item);
  const toPush = [...pool.values()].slice(0, 10);

  log.step(`推送政策索引 ${toPush.length} 条`);
  const sent = [];
  for (const item of toPush) {
    const ok = await send(buildPolicyCard(item), { ...notifyOpts, label: item.title });
    if (ok) sent.push(item.id);
    await sleep(400);
  }
  await markPushed(sent, topic);
  log.step('完成。');
}

main().catch((err) => {
  log.error(`政策频道中断：${err.message}`);
  process.exitCode = 1;
});
