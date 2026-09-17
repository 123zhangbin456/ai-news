import { parseFeed } from './parse.js';
import { isAllowedByRobots } from './robots.js';
import { normalizeUrl, urlId } from './dedupe.js';
import { hoursAgo, log, mapLimit } from './util.js';

function hitKeyword(title, keywords) {
  const t = String(title ?? '');
  return keywords.find((k) => t.includes(k)) ?? null;
}

async function fetchRss(source, cfg) {
  const allowed = await isAllowedByRobots(source.url, {
    userAgent: cfg.userAgent,
    timeoutMs: cfg.fetchTimeoutMs,
  });
  if (!allowed) {
    return { source, ok: false, error: 'robots.txt 不允许抓取该路径，已跳过', items: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': cfg.userAgent,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { source, ok: false, error: `HTTP ${res.status}`, items: [] };
    const body = await res.text();
    if (!body.trimStart().startsWith('<') && !body.includes('<rss') && !body.includes('<feed')) {
      return { source, ok: false, error: '返回内容不是订阅源', items: [] };
    }
    const items = parseFeed(body);
    return { source, ok: true, items };
  } catch (err) {
    const reason = err.name === 'AbortError' ? '请求超时' : '网络请求失败';
    return { source, ok: false, error: reason, items: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从官方 RSS 拉取，仅保留标题命中关键词的条目。
 * 不打开政策正文页，不下载附件。
 */
export async function fetchPolicyItems(cfg) {
  const sources = (cfg.sources ?? []).filter((s) => s.enabled !== false);
  const results = await mapLimit(sources, 2, (s) => fetchRss(s, cfg));

  const maxAgeHours = (cfg.maxAgeDays ?? 30) * 24;
  const out = [];
  const now = new Date();

  for (const r of results) {
    if (!r.ok) {
      log.warn(`${r.source.name.padEnd(16)} ${r.error}`);
      continue;
    }
    log.ok(`${r.source.name.padEnd(16)} ${r.items.length} 条（过滤前）`);

    for (const item of r.items) {
      const kw = hitKeyword(item.title, cfg.keywords);
      if (!kw) continue;
      if (item.publishedAt && hoursAgo(item.publishedAt, now) > maxAgeHours) continue;

      // id 用归一化 URL 去重；对外跳转保留官方原始链接（勿去掉 www.gov.cn）
      const rawUrl = String(item.url).trim();
      const url = normalizeUrl(rawUrl);
      out.push({
        id: urlId(url),
        title: item.title,
        url: rawUrl,
        summary: '', // 刻意不存摘要/正文，避免接近转载
        source: {
          id: r.source.id,
          name: r.source.name,
          type: 'official_rss',
          weight: 5,
        },
        domain: cfg.domain,
        topic: cfg.topic,
        lang: 'zh',
        category: '政策公开',
        keywords: [kw],
        score: 80,
        confidence: 1,
        related: [],
        interpret: null,
        noInterpret: true,
        publishedAt: item.publishedAt,
        pushed: false,
      });
    }
  }

  // URL 去重
  const byId = new Map();
  for (const item of out) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}
