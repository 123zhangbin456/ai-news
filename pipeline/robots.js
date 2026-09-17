/**
 * 极简 robots.txt 检查：只判断某 URL 的 path 是否被 Disallow。
 * 拿不到 robots 或解析失败时，保守地允许「官方 RSS」类源，拒绝「页面抓取」类源。
 */
const cache = new Map();

async function loadRobots(origin, userAgent, timeoutMs) {
  const key = origin;
  if (cache.has(key)) return cache.get(key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      const empty = { allowAll: true, disallows: [] };
      cache.set(key, empty);
      return empty;
    }
    const text = await res.text();
    const disallows = [];
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [k, ...rest] = line.split(':');
      const keyName = k.trim().toLowerCase();
      const val = rest.join(':').trim();
      if (keyName === 'user-agent') {
        applies = val === '*' || userAgent.toLowerCase().includes(val.toLowerCase());
      } else if (applies && keyName === 'disallow' && val) {
        disallows.push(val);
      }
    }
    const parsed = { allowAll: false, disallows };
    cache.set(key, parsed);
    return parsed;
  } catch {
    const fallback = { allowAll: true, disallows: [] };
    cache.set(key, fallback);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** path 是否被某条 Disallow 前缀命中 */
export function pathAllowed(pathname, disallows) {
  if (!disallows?.length) return true;
  for (const rule of disallows) {
    if (rule === '/') return false;
    if (pathname.startsWith(rule)) return false;
  }
  return true;
}

/**
 * @param {string} url
 * @param {{ userAgent: string, timeoutMs?: number, failOpenForRss?: boolean }} opts
 */
export async function isAllowedByRobots(url, opts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const robots = await loadRobots(parsed.origin, opts.userAgent, opts.timeoutMs ?? 10000);
  if (robots.allowAll) return true;
  return pathAllowed(parsed.pathname, robots.disallows);
}
