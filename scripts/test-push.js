/**
 * 验证飞书 webhook 是否配置正确，不跑抓取、不碰数据。
 *
 *   FEISHU_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx' npm run test-push
 *
 * 开了签名校验就再带上 FEISHU_SECRET。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_DIR, log, isoBeijing } from '../pipeline/util.js';
import { buildItemCard, send } from '../pipeline/notify.js';

const webhook = process.env.FEISHU_WEBHOOK;
const secret = process.env.FEISHU_SECRET;

if (!webhook) {
  log.error('没有读到 FEISHU_WEBHOOK。');
  log.info("用法：FEISHU_WEBHOOK='粘贴地址' npm run test-push");
  process.exit(1);
}

if (!/^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\//.test(webhook)) {
  log.error('这个地址看起来不是自定义机器人的 webhook。');
  log.info('正确的格式：https://open.feishu.cn/open-apis/bot/v2/hook/后面跟一串 id');
  log.info('如果你拿到的是 applink.feishu.cn 开头的链接，那是应用分享链接，不是 webhook。');
  log.info('自定义机器人要在「群设置 → 群机器人 → 添加机器人 → 自定义机器人」里加。');
  process.exit(1);
}

const config = JSON.parse(await readFile(join(PIPELINE_DIR, 'config.json'), 'utf8'));

const card = buildItemCard({
  title: 'AI 日报接通成功',
  url: 'https://github.com',
  summary: '这是一条测试消息。看到它说明 webhook 配置正确，接下来把地址填进 GitHub Secrets 就能自动推送了。',
  category: '模型发布',
  score: 88,
  publishedAt: isoBeijing(),
  source: { name: '配置自检' },
  related: [],
});

log.info('正在发送测试卡片…');
const ok = await send(card, { webhook, secret, retry: config.notifyRetry, dryRun: false });

if (ok) {
  log.ok('发送成功，去飞书群里看看。');
} else {
  log.error('发送失败。');
  log.info('常见原因：地址复制少了一截；开了签名校验但没传 FEISHU_SECRET；');
  log.info('或者机器人设了自定义关键词，而消息里不含那个词。');
  process.exitCode = 1;
}
