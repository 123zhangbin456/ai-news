import { join } from 'node:path';
import { parseFeed } from './parse.js';
import { DATA_DIR, readJSON, writeJSON, mapLimit, log, dayKey } from './util.js';

const CACHE_PATH = join(DATA_DIR, 'http-cache.json');
const HEALTH_PATH = join(DATA_DIR, 'health.json');

// 部分源（Reddit、Cloudflare 站点）会拒绝默认的 Node UA
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchOne(source, cache, timeoutMs) {
  const cached = cache[source.id] ?? {};
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' };
  if (cached.etag) headers['If-None-Match'] = cached.etag;
  if (cached.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(source.url, { headers, signal: controller.signal, redirect: 'follow' });

    // 内容未变化，省下一次完整下载（OpenAI 源有 730KB）
    if (res.status === 304) {
      return { source, items: [], ok: true, notModified: true };
    }
    if (!res.ok) {
      return { source, items: [], ok: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();

    // 有些源停止维护后会返回 HTML 首页而不是 404，这种情况要识别出来
    if (contentType.includes('text/html') && !body.trimStart().startsWith('<?xml')) {
      return { source, items: [], ok: false, error: '返回 HTML 而非订阅源，该源可能已停止维护' };
    }

    const items = parseFeed(body);
    if (items.length === 0) {
      return { source, items: [], ok: false, error: '订阅源为空或格式无法解析' };
    }

    cache[source.id] = {
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    };
    return { source, items, ok: true };
  } catch (err) {
    const reason = err.name === 'AbortError' ? '请求超时' : '网络请求失败';
    return { source, items: [], ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取全部启用的源。单源失败不影响其他源。
 * 返回 { items, health, newlyBroken }，newlyBroken 是刚达到告警阈值的源。
 */
export async function fetchAll(sources, config, { dryRun = false } = {}) {
  const enabled = sources.filter((s) => s.enabled !== false);
  const cache = (await readJSON(CACHE_PATH, {})) ?? {};
  const health = (await readJSON(HEALTH_PATH, {})) ?? {};
  const today = dayKey();

  const results = await mapLimit(enabled, config.fetchConcurrency, (s) =>
    fetchOne(s, cache, config.fetchTimeoutMs)
  );

  const items = [];
  const newlyBroken = [];

  for (const r of results) {
    const id = r.source.id;
    const prev = health[id] ?? { failDays: 0, lastFailDay: null, lastError: null };

    if (r.ok) {
      health[id] = { failDays: 0, lastFailDay: null, lastError: null, lastOkDay: today };
      const tag = r.notModified ? '未更新' : `${r.items.length} 条`;
      log.ok(`${r.source.name.padEnd(18)} ${tag}`);
    } else {
      // 同一天内多次运行只算一次失败，否则半小时一跑很快就误报
      const failDays = prev.lastFailDay === today ? prev.failDays : prev.failDays + 1;
      health[id] = { ...prev, failDays, lastFailDay: today, lastError: r.error };
      log.warn(`${r.source.name.padEnd(18)} ${r.error}`);

      if (failDays === config.sourceFailAlertDays) {
        newlyBroken.push({ name: r.source.name, url: r.source.url, error: r.error });
      }
    }

    for (const item of r.items) {
      items.push({ ...item, source: r.source });
    }
  }

  // dry-run 必须保持无副作用：写了 ETag 缓存会让紧接着的真实运行拿到 304，
  // 白白漏掉这一批新闻
  if (!dryRun) {
    await writeJSON(CACHE_PATH, cache);
    await writeJSON(HEALTH_PATH, health);
  }

  return { items, health, newlyBroken };
}

/** npm run check 使用：逐个探测源是否可用，不写任何文件 */
export async function checkSources(sources, config) {
  const results = await mapLimit(sources, config.fetchConcurrency, (s) =>
    fetchOne(s, {}, config.fetchTimeoutMs)
  );
  return results.map((r) => ({
    name: r.source.name,
    url: r.source.url,
    enabled: r.source.enabled !== false,
    ok: r.ok,
    count: r.items.length,
    error: r.error ?? null,
    sample: r.items[0]?.title ?? null,
  }));
}
