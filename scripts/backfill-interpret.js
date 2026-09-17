/**
 * 给已入库、尚无解读的条目补中文解读（一次性回填）。
 *
 *   DEEPSEEK_API_KEY='sk-...' node scripts/backfill-interpret.js
 *   DEEPSEEK_API_KEY='sk-...' node scripts/backfill-interpret.js --limit=20 --min-score=30
 */
import { join } from 'node:path';
import {
  DATA_DIR, PIPELINE_DIR, readJSON, writeJSON, log, dayKey, isoBeijing,
} from '../pipeline/util.js';
import { interpretItems } from '../pipeline/interpret.js';
import { rebuildIndex } from '../pipeline/store.js';

function parseArgs(argv) {
  const kv = Object.fromEntries(
    argv.filter((a) => a.includes('=')).map((a) => a.replace(/^--/, '').split('='))
  );
  return {
    limit: Number(kv.limit ?? 20),
    minScore: Number(kv['min-score'] ?? 30),
    day: kv.day ?? dayKey(),
  };
}

const args = parseArgs(process.argv.slice(2));
if (!process.env.DEEPSEEK_API_KEY) {
  log.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

const config = await readJSON(join(PIPELINE_DIR, 'config.json'));
const dayPath = join(DATA_DIR, `${args.day}.json`);
const day = await readJSON(dayPath);
if (!day?.items?.length) {
  log.error(`没有找到 ${args.day} 的数据`);
  process.exit(1);
}

const need = day.items
  .filter((i) => !i.interpret?.headline)
  .filter((i) => (i.score ?? 0) >= args.minScore)
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  .slice(0, args.limit);

log.info(`${args.day} 共 ${day.items.length} 条，待补解读 ${need.length} 条（limit=${args.limit}, minScore=${args.minScore}）`);
if (need.length === 0) {
  log.ok('没有需要回填的条目');
  process.exit(0);
}

const updated = await interpretItems(need, {
  ...config,
  interpretMinScore: 0,
  maxInterpretPerRun: need.length,
  interpretConcurrency: config.interpretConcurrency ?? 3,
});

const byId = new Map(updated.map((i) => [i.id, i]));
let filled = 0;
day.items = day.items.map((i) => {
  const u = byId.get(i.id);
  if (u?.interpret?.headline) {
    filled++;
    return { ...i, interpret: u.interpret };
  }
  return i;
});
day.items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
day.updatedAt = isoBeijing();
await writeJSON(dayPath, day);

const rules = await readJSON(join(PIPELINE_DIR, 'rules.json'));
await rebuildIndex(rules, [args.day]);

log.ok(`回填完成：成功写入 ${filled} 条解读到 ${args.day}.json`);
