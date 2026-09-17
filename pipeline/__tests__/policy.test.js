import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathAllowed } from '../robots.js';
import { buildPolicyCard } from '../notify.js';

test('robots Disallow 前缀匹配', () => {
  assert.equal(pathAllowed('/zhengce/x', ['/2016zhengce/']), true);
  assert.equal(pathAllowed('/2016zhengce/foo', ['/2016zhengce/']), false);
  assert.equal(pathAllowed('/anything', ['/']), false);
});

test('政策卡片只有标题和跳转，不含解读正文', () => {
  const card = buildPolicyCard({
    title: '关于加强农民工工资支付保障的通知',
    url: 'https://www.gov.cn/zhengce/example.htm',
    keywords: ['农民工工资'],
    publishedAt: '2026-09-17T12:00:00+08:00',
    source: { name: '中国政府网' },
  });
  const body = card.elements[0].text.content;
  assert.match(body, /农民工工资支付保障/);
  assert.match(body, /官网阅读原文/);
  assert.equal(card.header.title.content.includes('农民工'), true);
  assert.equal(body.includes('takeaway'), false);
});
