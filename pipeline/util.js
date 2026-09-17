import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const PIPELINE_DIR = join(ROOT, 'pipeline');

const TZ = 'Asia/Shanghai';

/* ---------- 时间：全部以北京时间为准 ---------- */

/** 把各种脏输入收成有效 Date；解析失败则回退，避免 Intl 抛 Invalid time value */
export function asDate(value, fallback = new Date()) {
  if (value == null || value === '') return fallback;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : value;
  }
  // 纯数字时间戳（秒/毫秒）以字符串出现时，Date 构造会失败
  if (typeof value === 'string' && /^\d{10,13}$/.test(value.trim())) {
    const n = Number(value.trim());
    const ms = value.trim().length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const partsOf = (date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
      .formatToParts(asDate(date))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );

/** 北京时间的日期键，如 "2026-09-17"。系统用它划分"一天" */
export function dayKey(date = new Date()) {
  const p = partsOf(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 北京时间的小时（0-23），用于判断静默期 */
export function hourOf(date = new Date()) {
  return Number(partsOf(date).hour);
}

/** 带 +08:00 偏移的 ISO 串，前端直接显示不用再转换 */
export function isoBeijing(date = new Date()) {
  const p = partsOf(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/** "9月17日 08:30" 这样的展示用格式 */
export function displayTime(date = new Date()) {
  const p = partsOf(date);
  return `${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute}`;
}

export function hoursAgo(date, now = new Date()) {
  return (asDate(now).getTime() - asDate(date, asDate(now)).getTime()) / 3_600_000;
}

/* ---------- 文件读写 ---------- */

export async function readJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // 文件损坏时不让整条流水线崩掉，退回默认值，下次写入会覆盖修复
    log.warn(`配置或数据文件解析失败，已使用默认值: ${path}`);
    return fallback;
  }
}

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/* ---------- 杂项 ---------- */

export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 并发上限执行，避免同时打开几十个连接被源站限流 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const LEVELS = { info: '·', ok: '✓', warn: '!', error: '✗' };
const write = (level, msg) => console.log(`${LEVELS[level]} ${msg}`);

export const log = {
  info: (m) => write('info', m),
  ok: (m) => write('ok', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
  step: (m) => console.log(`\n${m}`),
};
