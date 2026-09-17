import { join } from 'node:path';
import { DATA_DIR, readJSON, writeJSON, dayKey, isoBeijing, hoursAgo } from './util.js';

const SEEN_PATH = join(DATA_DIR, 'seen.json');
const INDEX_PATH = join(DATA_DIR, 'index.json');
const STATE_PATH = join(DATA_DIR, 'state.json');
const dayPath = (key) => join(DATA_DIR, `${key}.json`);

/* ---------- 运行状态 ---------- */

/**
 * 定时任务可能延迟触发、也可能被手动重跑，光看时间判断会重复发晨报。
 * 记下最后一次发晨报的日期作为幂等依据。
 */
export async function digestSentToday() {
  const state = (await readJSON(STATE_PATH, {})) ?? {};
  return state.lastDigestDay === dayKey();
}

export async function markDigestSent() {
  const state = (await readJSON(STATE_PATH, {})) ?? {};
  await writeJSON(STATE_PATH, { ...state, lastDigestDay: dayKey(), lastDigestAt: isoBeijing() });
}

/* ---------- URL 指纹表 ---------- */

/** seen.json 形如 { "a3f8c1d2": "2026-09-17" }，滚动保留 N 天 */
export async function loadSeen(retentionDays) {
  const raw = (await readJSON(SEEN_PATH, {})) ?? {};
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffKey = dayKey(cutoff);

  const kept = {};
  for (const [id, day] of Object.entries(raw)) {
    if (day >= cutoffKey) kept[id] = day;
  }
  return kept;
}

export async function saveSeen(seen, newIds) {
  const today = dayKey();
  for (const id of newIds) seen[id] = today;
  await writeJSON(SEEN_PATH, seen);
}

/* ---------- 按天的数据文件 ---------- */

export async function loadDay(key) {
  return (await readJSON(dayPath(key), null)) ?? { date: key, updatedAt: null, items: [] };
}

export async function saveDay(key, day) {
  await writeJSON(dayPath(key), { ...day, date: key, updatedAt: isoBeijing() });
}

/** 一条新闻归属哪一天，以发布时间的北京日期为准 */
const dayOf = (item) => dayKey(item.publishedAt ? new Date(item.publishedAt) : new Date());

/** 写入新条目，按发布日期分派到对应的天文件 */
export async function appendItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = dayOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, group] of groups) {
    const day = await loadDay(key);
    const existing = new Set(day.items.map((i) => i.id));
    day.items.push(...group.filter((i) => !existing.has(i.id)));
    day.items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    await saveDay(key, day);
  }
  return [...groups.keys()];
}

/* ---------- 推送状态 ---------- */

/** 取出还没推送过的条目。withinHours 决定回看几天的数据文件。 */
export async function loadUnpushed(withinHours = 30) {
  const dayCount = Math.max(2, Math.ceil(withinHours / 24) + 1);
  const keys = [];
  for (let i = 0; i < dayCount; i++) {
    keys.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }
  const out = [];
  for (const key of keys) {
    const day = await loadDay(key);
    for (const item of day.items) {
      if (!item.pushed && hoursAgo(item.fetchedAt ?? item.publishedAt) <= withinHours) {
        out.push(item);
      }
    }
  }
  return out;
}

export async function markPushed(ids) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  // 多扫一些天，覆盖 Cursor 补录的跨周条目
  const keys = [];
  for (let i = 0; i < 16; i++) {
    keys.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }

  for (const key of keys) {
    const day = await loadDay(key);
    let touched = false;
    for (const item of day.items) {
      if (idSet.has(item.id) && !item.pushed) {
        item.pushed = true;
        item.pushedAt = isoBeijing();
        touched = true;
      }
    }
    if (touched) await saveDay(key, day);
  }
}

/* ---------- 索引与历史标题 ---------- */

/** 前端首屏读这个文件决定有哪些日期可选 */
export async function rebuildIndex(rules, recentDayKeys) {
  const index = (await readJSON(INDEX_PATH, null)) ?? { days: [], categories: [] };
  const byDate = new Map(index.days.map((d) => [d.date, d]));

  for (const key of recentDayKeys) {
    const day = await loadDay(key);
    const categories = {};
    for (const item of day.items) {
      categories[item.category] = (categories[item.category] ?? 0) + 1;
    }
    byDate.set(key, { date: key, count: day.items.length, categories });
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 180);
  const payload = {
    updatedAt: isoBeijing(),
    categories: [...rules.categories.map((c) => ({ name: c.name, icon: c.icon })), { name: '其他', icon: '📰' }],
    days,
  };
  await writeJSON(INDEX_PATH, payload);
  return payload;
}

/** 供去重比对：最近几天已收录的标题 */
export async function loadRecentTitles(days = 3) {
  const titles = [];
  for (let i = 0; i < days; i++) {
    const day = await loadDay(dayKey(new Date(Date.now() - i * 86_400_000)));
    for (const item of day.items) titles.push(item.title);
  }
  return titles;
}
