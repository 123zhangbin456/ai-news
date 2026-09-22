/**
 * 验证飞书 webhook，并预览新版卡片样式（展开解读 + 源健康告警）。
 *
 *   FEISHU_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx' npm run test-push
 *
 * 开了签名校验就再带上 FEISHU_SECRET。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_DIR, log, isoBeijing } from '../pipeline/util.js';
import { buildItemCard, buildHealthCard, send } from '../pipeline/notify.js';

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
const opts = { webhook, secret, retry: config.notifyRetry, dryRun: false };

const newsCard = buildItemCard({
  title: 'Alibaba open-sources Qwen-Image-2.1 with transparent image editing',
  url: 'https://github.com',
  summary:
    'Alibaba open-sourced a 7B visual generation model that combines text-to-image, transparent image generation, and image editing in one checkpoint.',
  category: '模型发布',
  score: 72,
  publishedAt: isoBeijing(),
  source: { name: '开源中国' },
  related: [],
  interpret: {
    headline: '通义千问开源 Qwen-Image-2.1：7B 模型整合文生图、透明图与图像编辑',
    takeaway: '阿里开源 7B 视觉生成模型，把文生图、透明图生成和图像编辑合为一体，兼顾效果、效率与成本。',
    bullets: [
      '视觉生成部分仅 7B 参数，采用 32 层 Single-Stream DiT 架构',
      '一个模型同时支持文生图、透明图生成与图像编辑',
      '原生支持透明图像的生成与编辑，减少多模型拼接成本',
    ],
  },
});

const healthCard = buildHealthCard([
  { name: 'arXiv cs.AI', error: '订阅源为空或格式无法解析' },
  { name: 'arXiv cs.CL', error: '订阅源为空或格式无法解析' },
]);

log.info('正在发送新闻卡（含展开）…');
const okNews = await send(newsCard, { ...opts, label: '预览·新闻卡' });

log.info('正在发送源健康告警卡…');
const okHealth = await send(healthCard, { ...opts, label: '预览·告警卡' });

if (okNews && okHealth) {
  log.ok('两条预览都已发出，去飞书群里看看。');
} else {
  log.error('有卡片发送失败。');
  log.info('常见原因：地址复制少了一截；开了签名校验但没传 FEISHU_SECRET；');
  log.info('或者机器人设了自定义关键词，而消息里不含那个词。');
  process.exitCode = 1;
}
