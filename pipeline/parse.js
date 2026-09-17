import { XMLParser } from 'fast-xml-parser';

const BASE_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
  removeNSPrefix: false,
};

// 解析器默认只允许展开 1000 个 XML 实体（防 XML 炸弹）。正常 RSS 里满篇
// &amp; &lt; 很容易超标，上千条的大源必然触发。放宽到仍然安全的量级。
const parser = new XMLParser({
  ...BASE_OPTIONS,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 500_000,
    maxExpandedLength: 20_000_000,
  },
});

// 兜底：源真的畸形时不展开实体也要能读出标题，交给 stripHtml 收尾
const rawParser = new XMLParser({ ...BASE_OPTIONS, processEntities: false });

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, '&');

/**
 * 把 <p>、&amp; 之类清理成纯文本。
 * 先解实体再去标签：源里的内容常是双重转义的（&lt;p&gt;），顺序反了就会留下裸标签。
 */
export function stripHtml(input, maxLen = 240) {
  if (!input) return '';
  const text = decodeEntities(String(input))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  const clean = decodeEntities(text)
    .replace(/:[a-z0-9_+-]{2,20}:/gi, '') // 部分源把 :fire: 这类表情代码原样吐出来
    .replace(/\s+/g, ' ')
    // 去标签时补的空格在英文里是必要的（否则单词会粘连），但中文不用空格分词，
    // 会留下"新模型 正式 上线"这种断裂感，这里把汉字之间的空格收回去
    .replace(/(?<=[\u4e00-\u9fff\u3000-\u303f]) (?=[\u4e00-\u9fff\u3000-\u303f])/g, '')
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** 字段可能是字符串、也可能是 { '#text': ... } 这样的对象 */
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return textOf(node['#text'] ?? '');
  return '';
}

/**
 * RSS 的 link 是文本，Atom 的是属性，且 Atom 常有多个 link。
 * 必须挑 rel="alternate"（正文地址），不能拿到 rel="self"（订阅源自身地址）。
 */
function linkOf(entry) {
  const links = asArray(entry.link);

  const objectLinks = links.filter((l) => l && typeof l === 'object' && l['@href']);
  if (objectLinks.length) {
    const alternate = objectLinks.find((l) => !l['@rel'] || l['@rel'] === 'alternate');
    const href = String((alternate ?? objectLinks[0])['@href']);
    if (href.startsWith('http')) return href;
  }

  const plain = links.map((l) => textOf(l)).find((s) => s.startsWith('http'));
  if (plain) return plain;

  // RSS 1.0 和部分源把真实地址放在 guid 里
  const guid = textOf(entry.guid);
  return guid.startsWith('http') ? guid : '';
}

function dateOf(entry) {
  const raw =
    textOf(entry.pubDate) ||
    textOf(entry.published) ||
    textOf(entry.updated) ||
    textOf(entry['dc:date']) ||
    textOf(entry.date);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function summaryOf(entry) {
  return stripHtml(
    textOf(entry.description) ||
      textOf(entry.summary) ||
      textOf(entry['content:encoded']) ||
      textOf(entry.content)
  );
}

/**
 * 解析 RSS 2.0 / Atom / RSS 1.0 (RDF) 三种格式。
 * 返回原始条目，尚未归一化、未分类。
 */
export function parseFeed(xml) {
  if (!xml || !xml.trim().startsWith('<')) return [];

  let root;
  try {
    root = parser.parse(xml);
  } catch {
    try {
      root = rawParser.parse(xml);
    } catch {
      return [];
    }
  }

  const entries = [
    ...asArray(root?.rss?.channel?.item),
    ...asArray(root?.channel?.item),
    ...asArray(root?.['rdf:RDF']?.item),
    ...asArray(root?.RDF?.item),
    ...asArray(root?.feed?.entry),
  ];

  return entries
    .map((e) => ({
      title: stripHtml(textOf(e.title), 300),
      url: linkOf(e),
      summary: summaryOf(e),
      publishedAt: dateOf(e),
      author: stripHtml(textOf(e.author?.name ?? e.author ?? e['dc:creator']), 60),
    }))
    .filter((e) => e.title && e.url);
}
