/**
 * 验证 DeepSeek Key 能否生成解读，并可选发一张飞书卡片。
 *
 *   DEEPSEEK_API_KEY='sk-...' npm run test-interpret
 *   DEEPSEEK_API_KEY='sk-...' FEISHU_WEBHOOK='...' npm run test-interpret
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_DIR, log } from '../pipeline/util.js';
import { ensureInterpreted } from '../pipeline/interpret.js';
import { buildItemCard, send } from '../pipeline/notify.js';

if (!process.env.DEEPSEEK_API_KEY) {
  log.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

const config = JSON.parse(await readFile(join(PIPELINE_DIR, 'config.json'), 'utf8'));

const sample = {
  id: 'test-interpret',
  title: 'Claude comes for Gemini with its own take on Docs and Slides',
  summary:
    "Claude is getting a pair of new tools today: Docs and Slides. They'll let you create documents and presentations.",
  category: '模型发布',
  score: 62,
  publishedAt: new Date().toISOString(),
  url: 'https://www.theverge.com/example',
  source: { name: 'The Verge AI', type: 'ai', weight: 4 },
};

log.info('正在调用 DeepSeek 生成解读…');
const [done] = await ensureInterpreted([sample], config);

if (!done.interpret?.headline) {
  log.error('解读失败，没有返回 headline');
  process.exit(1);
}

console.log('\n中文标题：', done.interpret.headline);
console.log('一句话：', done.interpret.takeaway);
console.log('要点：');
for (const b of done.interpret.bullets ?? []) console.log(' ·', b);

if (process.env.FEISHU_WEBHOOK) {
  log.info('发送测试卡片到飞书…');
  const ok = await send(buildItemCard(done), {
    webhook: process.env.FEISHU_WEBHOOK,
    secret: process.env.FEISHU_SECRET,
    retry: config.notifyRetry,
    dryRun: false,
    label: done.interpret.headline,
  });
  if (ok) log.ok('飞书已收到带解读的测试卡片');
  else process.exitCode = 1;
} else {
  log.ok('解读成功。若要同时测飞书，加上 FEISHU_WEBHOOK 再跑一次。');
}
