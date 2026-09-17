import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostlyChinese } from '../interpret.js';
import { buildItemCard } from '../notify.js';

test('mostlyChinese 能区分中英文标题', () => {
  assert.equal(mostlyChinese('OpenAI launches GPT-5'), false);
  assert.equal(mostlyChinese('OpenAI 完成新一轮融资'), true);
});

test('飞书卡片优先展示中文解读', () => {
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

  const body = card.elements[0].text.content;
  assert.match(body, /Claude 推出文档与幻灯片能力/);
  assert.match(body, /对标 Gemini/);
  assert.match(body, /原文：Claude comes for Gemini/);
});
