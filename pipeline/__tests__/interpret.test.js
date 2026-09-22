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
      detail: 'Anthropic 为 Claude 增加文档与幻灯片能力，对标 Gemini 办公场景。',
    },
  });

  assert.equal(card.schema, '2.0');
  const body = card.body.elements.map((e) => e.content ?? e.elements?.[0]?.content ?? '').join('\n');
  assert.match(body, /Claude 推出文档与幻灯片能力/);
  assert.match(body, /对标 Gemini/);
  assert.match(body, /原文标题：Claude comes for Gemini/);
  assert.match(body, /补充/);
  assert.match(body, /Anthropic 为 Claude/);
  assert.doesNotMatch(body, /Claude is getting Docs/);

  const fold = card.body.elements.find((e) => e.tag === 'collapsible_panel');
  assert.ok(fold);
  assert.equal(fold.expanded, false);
  assert.equal(fold.header.title.content, '展开');

  const readBtn = card.body.elements.find((e) => e.tag === 'button');
  assert.equal(readBtn?.text?.content, '阅读原文');
  assert.equal(readBtn?.behaviors?.[0]?.default_url, 'https://example.com/x');
});

test('有解读时不把英文摘要塞进补充', () => {
  const card = buildItemCard({
    title: 'FQ-42 delivered',
    summary: 'Creech Air Force Base received a new FQ-42 Vengeance aircraft on Friday.',
    category: '装备动态',
    score: 50,
    publishedAt: '2026-09-22T12:00:00+08:00',
    url: 'https://example.com/m',
    source: { name: 'Defense News' },
    interpret: {
      headline: '通用原子向美空军交付 FQ-42',
      takeaway: '无人机交付克里奇基地继续测试。',
      bullets: ['周五交付一架 FQ-42', '用于测试评估'],
    },
  });
  const fold = card.body.elements.find((e) => e.tag === 'collapsible_panel');
  const content = fold.elements[0].content;
  assert.doesNotMatch(content, /Creech Air Force Base/);
  assert.doesNotMatch(content, /\*\*补充\*\*/);
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
