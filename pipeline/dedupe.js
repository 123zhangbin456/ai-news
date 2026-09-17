import { sha1 } from './util.js';

/* ---------- URL 归一化 ---------- */

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'dclid', 'yclid', 'twclid',
  'spm', 'scene', 'chksm', 'from', 'ref', 'ref_src', 'referrer',
  'mc_cid', 'mc_eid', 'igshid', 'share_token', 'shareid', 'share_source',
  '__twitter_impression', 'sr_share', 'CMP', 'cmp', 'mbid', 'itm_source',
  'itm_medium', 'itm_campaign', 'guccounter',
]);

/**
 * 同一篇文章在不同源里带着不同的跟踪参数，不归一化就会被当成不同文章。
 * 这一步把它们收敛成同一个字符串。
 */
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());

    if (u.protocol === 'http:') u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hash = '';

    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key)) {
        u.searchParams.delete(key);
      }
    }
    u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';

    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}

export const urlId = (raw) => sha1(normalizeUrl(raw));

/* ---------- 标题相似度 ---------- */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'by', 'at', 'as', 'its', 'it', 'this', 'that', 'from', 'new',
]);

/**
 * 中文用字符二元组（无需分词库），英文用词集合。
 * 混排标题按 CJK 占比决定走哪条路径。
 */
function tokenize(title) {
  const clean = String(title).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!clean) return new Set();

  const cjkCount = [...clean].filter((c) => CJK.test(c)).length;
  const isChinese = cjkCount / clean.length > 0.2;

  if (isChinese) {
    const chars = clean.replace(/\s+/g, '');
    const grams = new Set();
    for (let i = 0; i < chars.length - 1; i++) grams.add(chars.slice(i, i + 2));
    return grams;
  }

  return new Set(clean.split(/\s+/).filter((w) => w.length >= 3 && !EN_STOPWORDS.has(w)));
}

export function titleSimilarity(a, b) {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;

  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/* ---------- 去重主流程 ---------- */

/** 同一事件保留哪一条：来源权重优先，其次摘要更完整的 */
function better(a, b) {
  const wa = a.source?.weight ?? 0;
  const wb = b.source?.weight ?? 0;
  if (wa !== wb) return wa > wb ? a : b;
  return (a.summary?.length ?? 0) >= (b.summary?.length ?? 0) ? a : b;
}

/**
 * 三层过滤：
 *   1. URL 指纹命中历史 → 直接丢弃
 *   2. 标题与近几天已收录的内容高度相似 → 丢弃（同一事件的迟到报道）
 *   3. 本批次内部互相相似 → 合并成一条，其余进 related
 */
export function dedupe(items, { seenIds = new Set(), recentTitles = [], threshold = 0.62 } = {}) {
  const stats = { input: items.length, bySeenUrl: 0, byRecentTitle: 0, merged: 0 };

  const unseen = [];
  for (const item of items) {
    const id = urlId(item.url);
    if (seenIds.has(id)) {
      stats.bySeenUrl++;
      continue;
    }
    unseen.push({ ...item, id, canonicalUrl: normalizeUrl(item.url) });
  }

  // 批次内自身也可能有完全相同的 URL（两个源转载同一链接）
  const byId = new Map();
  for (const item of unseen) {
    const existing = byId.get(item.id);
    if (existing) {
      stats.bySeenUrl++;
      byId.set(item.id, better(existing, item));
    } else {
      byId.set(item.id, item);
    }
  }

  const candidates = [];
  for (const item of byId.values()) {
    const echo = recentTitles.some((t) => titleSimilarity(item.title, t) >= threshold);
    if (echo) {
      stats.byRecentTitle++;
      continue;
    }
    candidates.push(item);
  }

  // 权重高的先进入，成为簇的代表条目
  candidates.sort((a, b) => (b.source?.weight ?? 0) - (a.source?.weight ?? 0));

  const clusters = [];
  for (const item of candidates) {
    const hit = clusters.find((c) => titleSimilarity(c.head.title, item.title) >= threshold);
    if (hit) {
      hit.others.push(item);
      stats.merged++;
    } else {
      clusters.push({ head: item, others: [] });
    }
  }

  const fresh = clusters.map(({ head, others }) => ({
    ...head,
    related: others.map((o) => ({
      title: o.title,
      url: o.canonicalUrl,
      source: o.source?.name ?? '',
    })),
  }));

  return { fresh, stats };
}
