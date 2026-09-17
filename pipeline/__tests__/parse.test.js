import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, stripHtml } from '../parse.js';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例源</title>
    <item>
      <title><![CDATA[OpenAI 发布 GPT-5.5]]></title>
      <link>https://example.com/a?utm_source=rss</link>
      <description><![CDATA[<p>新模型<b>正式</b>上线</p>]]></description>
      <pubDate>Tue, 16 Sep 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>没有链接的条目</title>
      <description>应当被丢弃</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <entry>
    <title>Introducing Gemini</title>
    <link href="https://example.org/self" rel="self"/>
    <link href="https://example.org/post" rel="alternate"/>
    <summary>&lt;p&gt;双重转义的内容 &amp;amp; 符号&lt;/p&gt;</summary>
    <published>2026-09-16T10:00:00Z</published>
    <author><name>Someone</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RSS 1.0 源</title></channel>
  <item>
    <title>arXiv 论文标题</title>
    <link>http://arxiv.org/abs/2609.00001</link>
    <description>Abstract here</description>
    <dc:date>2026-09-16T08:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

test('解析 RSS 2.0，丢弃缺链接的条目', () => {
  const items = parseFeed(RSS2);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'OpenAI 发布 GPT-5.5');
  assert.equal(items[0].summary, '新模型正式上线');
  assert.ok(items[0].publishedAt instanceof Date);
});

test('解析 Atom，link 取 alternate 而非 self', () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.org/post');
  assert.equal(items[0].title, 'Introducing Gemini');
});

test('双重转义的摘要要还原成纯文本，不留裸标签', () => {
  const [item] = parseFeed(ATOM);
  assert.equal(item.summary, '双重转义的内容 & 符号');
});

test('解析 RSS 1.0 (RDF)，日期取 dc:date', () => {
  const items = parseFeed(RDF);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'http://arxiv.org/abs/2609.00001');
  assert.equal(items[0].publishedAt.getUTCFullYear(), 2026);
});

test('实体数量超过防炸弹默认上限的源仍能解析', () => {
  const many = Array.from({ length: 1500 }, (_, i) =>
    `<item><title>条目 ${i} &amp; more</title><link>https://e.com/${i}</link></item>`
  ).join('');
  const items = parseFeed(`<rss version="2.0"><channel>${many}</channel></rss>`);
  assert.equal(items.length, 1500);
});

test('畸形输入返回空数组而不抛异常', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>404</body></html>'), []);
  assert.deepEqual(parseFeed('not xml at all'), []);
});

test('stripHtml 去标签、解实体、清表情代码、截断', () => {
  assert.equal(stripHtml('<p>你好 &amp; 世界</p>'), '你好 & 世界');
  assert.equal(stripHtml(':fire::fire: 震撼发布'), '震撼发布');
  assert.equal(stripHtml('<script>evil()</script>正文'), '正文');
  assert.equal(stripHtml('abcdef', 3), 'abc…');
});
