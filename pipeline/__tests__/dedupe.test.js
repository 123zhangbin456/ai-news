import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, titleSimilarity, dedupe, urlId } from '../dedupe.js';

const item = (title, url, source) => ({
  title,
  url,
  summary: '',
  publishedAt: new Date(),
  source: { id: source.toLowerCase(), name: source, weight: source === 'OpenAI' ? 5 : 3 },
});

test('归一化去掉跟踪参数、统一协议与末尾斜杠', () => {
  assert.equal(
    normalizeUrl('http://www.Example.com/post/?utm_source=rss&utm_medium=feed#top'),
    'https://example.com/post'
  );
  assert.equal(normalizeUrl('https://example.com/a?id=7&fbclid=xyz'), 'https://example.com/a?id=7');
});

test('归一化保留有意义的查询参数', () => {
  assert.equal(normalizeUrl('https://example.com/p?page=2'), 'https://example.com/p?page=2');
});

test('带不同跟踪参数的同一篇文章得到同一个 id', () => {
  assert.equal(
    urlId('https://example.com/x?utm_campaign=a'),
    urlId('http://www.example.com/x/?spm=b')
  );
});

test('非法 URL 不抛异常', () => {
  assert.equal(normalizeUrl('javascript:void(0)'), 'javascript:void(0)');
});

test('中文标题相似度靠二元组，无需分词', () => {
  const a = '英伟达发布新一代 AI 芯片';
  const b = '英伟达正式发布新一代AI芯片';
  assert.ok(titleSimilarity(a, b) > 0.62);
  assert.ok(titleSimilarity(a, '苹果推出新款笔记本电脑') < 0.2);
});

test('英文标题相似度忽略停用词与大小写', () => {
  const a = 'OpenAI Releases the New GPT-5 Model';
  const b = 'OpenAI releases new GPT-5 model';
  assert.ok(titleSimilarity(a, b) > 0.62);
});

test('URL 指纹命中历史的条目被丢弃', () => {
  const known = urlId('https://example.com/old');
  const { fresh, stats } = dedupe([item('旧闻', 'https://example.com/old?utm_source=x', '量子位')], {
    seenIds: new Set([known]),
  });
  assert.equal(fresh.length, 0);
  assert.equal(stats.bySeenUrl, 1);
});

test('同一事件的多家报道合并，保留权重最高的源', () => {
  const { fresh, stats } = dedupe([
    item('英伟达发布新一代 AI 芯片', 'https://a.com/1', '钛媒体'),
    item('英伟达正式发布新一代AI芯片', 'https://b.com/2', 'OpenAI'),
    item('苹果推出新款笔记本电脑', 'https://c.com/3', '钛媒体'),
  ]);

  assert.equal(fresh.length, 2);
  assert.equal(stats.merged, 1);

  const merged = fresh.find((f) => f.title.includes('英伟达'));
  assert.equal(merged.source.name, 'OpenAI');
  assert.equal(merged.related.length, 1);
  assert.equal(merged.related[0].source, '钛媒体');
});

test('与近几天已收录标题高度相似的迟到报道被丢弃', () => {
  const { fresh, stats } = dedupe([item('英伟达发布新一代 AI 芯片', 'https://a.com/1', '钛媒体')], {
    recentTitles: ['英伟达正式发布新一代AI芯片'],
  });
  assert.equal(fresh.length, 0);
  assert.equal(stats.byRecentTitle, 1);
});
