import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DATA_DIR, PIPELINE_DIR, readJSON, writeJSON, dayKey, isoBeijing, hoursAgo } from './util.js';

const CATALOG_PATH = join(DATA_DIR, 'catalog.json');

/** topicId → domainId，来自 domains.json；读失败时用兜底表 */
function domainIdOf(topicId) {
  const fallback = { ai: 'tech', migrant: 'policy', military: 'military' };
  try {
    const path = join(PIPELINE_DIR, 'domains.json');
    if (!existsSync(path)) return fallback[topicId] ?? topicId;
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    for (const d of cfg.domains ?? []) {
      for (const t of d.topics ?? []) {
        if (t.id === topicId) return d.id;
      }
    }
  } catch {
    /* ignore */
  }
  return fallback[topicId] ?? topicId;
}

/** AI 沿用根目录 data/；其他主题进 data/<domain>/<topic>/ */
export function pathsFor(topic = 'ai') {
  if (!topic || topic === 'ai') {
    return {
      topic: 'ai',
      domain: 'tech',
      seen: join(DATA_DIR, 'seen.json'),
      index: join(DATA_DIR, 'index.json'),
      state: join(DATA_DIR, 'state.json'),
      day: (key) => join(DATA_DIR, `${key}.json`),
    };
  }
  const domain = domainIdOf(topic);
  const base = join(DATA_DIR, domain, topic);
  return {
    topic,
    domain,
    seen: join(base, 'seen.json'),
    index: join(base, 'index.json'),
    state: join(base, 'state.json'),
    day: (key) => join(base, `${key}.json`),
  };
}

export async function digestSentToday(topic = 'ai') {
  const p = pathsFor(topic);
  const state = (await readJSON(p.state, {})) ?? {};
  return state.lastDigestDay === dayKey();
}

export async function markDigestSent(topic = 'ai') {
  const p = pathsFor(topic);
  const state = (await readJSON(p.state, {})) ?? {};
  await writeJSON(p.state, { ...state, lastDigestDay: dayKey(), lastDigestAt: isoBeijing() });
}

export async function loadSeen(retentionDays, topic = 'ai') {
  const p = pathsFor(topic);
  const raw = (await readJSON(p.seen, {})) ?? {};
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffKey = dayKey(cutoff);
  const kept = {};
  for (const [id, day] of Object.entries(raw)) {
    if (day >= cutoffKey) kept[id] = day;
  }
  return kept;
}

export async function saveSeen(seen, newIds, topic = 'ai') {
  const p = pathsFor(topic);
  const today = dayKey();
  for (const id of newIds) seen[id] = today;
  await writeJSON(p.seen, seen);
}

export async function loadDay(key, topic = 'ai') {
  const p = pathsFor(topic);
  return (await readJSON(p.day(key), null)) ?? { date: key, updatedAt: null, items: [], topic };
}

export async function saveDay(key, day, topic = 'ai') {
  const p = pathsFor(topic);
  await writeJSON(p.day(key), { ...day, date: key, topic, updatedAt: isoBeijing() });
}

const dayOf = (item) => dayKey(item.publishedAt || item.fetchedAt || new Date());

export async function appendItems(items, topic = 'ai') {
  const groups = new Map();
  for (const item of items) {
    const key = dayOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, group] of groups) {
    const day = await loadDay(key, topic);
    const existing = new Set(day.items.map((i) => i.id));
    day.items.push(...group.filter((i) => !existing.has(i.id)));
    day.items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    await saveDay(key, day, topic);
  }
  return [...groups.keys()];
}

export async function loadUnpushed(withinHours = 30, topic = 'ai') {
  const dayCount = Math.max(2, Math.ceil(withinHours / 24) + 1);
  const out = [];
  for (let i = 0; i < dayCount; i++) {
    const key = dayKey(new Date(Date.now() - i * 86_400_000));
    const day = await loadDay(key, topic);
    for (const item of day.items) {
      if (!item.pushed && hoursAgo(item.fetchedAt ?? item.publishedAt) <= withinHours) {
        out.push(item);
      }
    }
  }
  return out;
}

export async function markPushed(ids, topic = 'ai') {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  for (let i = 0; i < 16; i++) {
    const key = dayKey(new Date(Date.now() - i * 86_400_000));
    const day = await loadDay(key, topic);
    let touched = false;
    for (const item of day.items) {
      if (idSet.has(item.id) && !item.pushed) {
        item.pushed = true;
        item.pushedAt = isoBeijing();
        touched = true;
      }
    }
    if (touched) await saveDay(key, day, topic);
  }
}

export async function patchItems(patches, topic = 'ai') {
  if (!patches?.length) return;
  const byId = new Map(patches.map((p) => [p.id, p]));
  for (let i = 0; i < 16; i++) {
    const key = dayKey(new Date(Date.now() - i * 86_400_000));
    const day = await loadDay(key, topic);
    let touched = false;
    for (const item of day.items) {
      const patch = byId.get(item.id);
      if (!patch) continue;
      Object.assign(item, patch);
      touched = true;
      byId.delete(item.id);
    }
    if (touched) {
      day.items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      await saveDay(key, day, topic);
    }
    if (byId.size === 0) break;
  }
}

export async function rebuildIndex(rules, recentDayKeys, topic = 'ai') {
  const p = pathsFor(topic);
  const index = (await readJSON(p.index, null)) ?? { days: [], categories: [] };
  const byDate = new Map(index.days.map((d) => [d.date, d]));

  for (const key of recentDayKeys) {
    const day = await loadDay(key, topic);
    const categories = {};
    for (const item of day.items) {
      categories[item.category] = (categories[item.category] ?? 0) + 1;
    }
    byDate.set(key, { date: key, count: day.items.length, categories });
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 180);
  const cats = rules?.categories
    ? [...rules.categories.map((c) => ({ name: c.name, icon: c.icon })), { name: '其他', icon: '📰' }]
    : [{ name: '政策公开', icon: '📜' }, { name: '其他', icon: '📰' }];

  const payload = {
    updatedAt: isoBeijing(),
    topic,
    categories: cats,
    days,
  };
  await writeJSON(p.index, payload);
  return payload;
}

export async function loadRecentTitles(days = 3, topic = 'ai') {
  const titles = [];
  for (let i = 0; i < days; i++) {
    const day = await loadDay(dayKey(new Date(Date.now() - i * 86_400_000)), topic);
    for (const item of day.items) titles.push(item.title);
  }
  return titles;
}

/** 汇总各主题索引，供前端首屏切换大类/二级主题 */
export async function rebuildCatalog(domainsConfig) {
  const topics = {};
  for (const domain of domainsConfig.domains ?? []) {
    for (const topic of domain.topics ?? []) {
      const p = pathsFor(topic.id);
      const index = (await readJSON(p.index, null)) ?? { days: [], categories: [] };
      topics[topic.id] = {
        domainId: domain.id,
        name: topic.name,
        icon: topic.icon,
        channel: topic.channel,
        updatedAt: index.updatedAt ?? null,
        categories: index.categories ?? [],
        days: index.days ?? [],
      };
    }
  }

  const catalog = {
    updatedAt: isoBeijing(),
    brand: domainsConfig.brand ?? '每日简报',
    domains: domainsConfig.domains,
    topics,
  };
  await writeJSON(CATALOG_PATH, catalog);
  // 兼容旧前端：根 index 仍指向 AI
  if (topics.ai) {
    await writeJSON(join(DATA_DIR, 'index.json'), {
      updatedAt: topics.ai.updatedAt,
      categories: topics.ai.categories,
      days: topics.ai.days,
    });
  }
  return catalog;
}
