import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostlyChinese } from '../interpret.js';
import { buildItemCard } from '../notify.js';

test('mostlyChinese 能区分中英文标题', () => {
  assert.equal(mostlyChinese('OpenAI launches GPT-5'), false);
  assert.equal(mostlyChinese('OpenAI 完成新一轮融资'), true);
});

test('飞书卡片优先展示中文解读，要点收入展开区', () => {
  const card = buildItemCard({
    title: 'Claude comes for Gemini with Docs',
    summary: 'Claude is getting Docs and Slides.',
    category: '模型发布',
    score: 70,
    publishedAt: '2026-09-17T12:00:00+08:00',
    url: 'https://example.com/x',
    source: { name: 'The Verge' },
    interpret: {
      headline: 'Claude 推出文档与幻灯片能力',
      takeaway: 'Anthropic 用 Docs/Slides 对标 Gemini 办公场景。',
      bullets: ['面向办公文档创作', '与 Gemini 形成直接竞争'],
    },
  });

  assert.equal(card.schema, '2.0');
  const body = card.body.elements.map((e) => e.content ?? e.elements?.[0]?.content ?? '').join('\n');
  assert.match(body, /Claude 推出文档与幻灯片能力/);
  assert.match(body, /对标 Gemini/);
  assert.match(body, /原文标题：Claude comes for Gemini/);
  assert.match(body, /补充/);

  const fold = card.body.elements.find((e) => e.tag === 'collapsible_panel');
  assert.ok(fold);
  assert.equal(fold.expanded, false);
  assert.equal(fold.header.title.content, '展开');

  const readBtn = card.body.elements.find((e) => e.tag === 'button');
  assert.equal(readBtn?.text?.content, '阅读原文');
  assert.equal(readBtn?.behaviors?.[0]?.default_url, 'https://example.com/x');
});

test('健康告警卡按原因分组并给出处理步骤', async () => {
  const { buildHealthCard } = await import('../notify.js');
  const card = buildHealthCard([
    { name: 'arXiv cs.AI', error: '订阅源为空或格式无法解析' },
    { name: 'arXiv cs.CL', error: '订阅源为空或格式无法解析' },
  ]);
  assert.match(card.header.title.content, /2 个新闻源异常/);
  assert.equal(card.header.template, 'orange');
  const body = card.elements.map((e) => e.text?.content ?? '').join('\n');
  assert.match(body, /arXiv cs\.AI/);
  assert.match(body, /怎么处理/);
  assert.match(body, /enabled/);
});
