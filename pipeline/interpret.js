import { isoBeijing, log, sleep, mapLimit } from './util.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

export const SYSTEM_AI = `你是一名资深科技编辑，面向中文读者解读 AI / Cursor 相关新闻。
根据给定的标题和摘要写解读，不要编造标题里没有的事实。
只输出一个 JSON 对象，不要 markdown，不要代码块，字段如下：
{
  "headline": "中文标题，简洁有信息量，不超过 40 字",
  "takeaway": "一句话结论：这是什么事、为什么值得看，不超过 60 字",
  "bullets": ["要点1", "要点2", "要点3"],
  "detail": "中文补充说明，把原文摘要改写成 2～3 句白话，不超过 120 字"
}
bullets 2～4 条，每条不超过 40 字，说清发生了什么、和谁有关、可能影响。
detail 必须用中文；原文是英文时要翻译改写，不要照抄英文。
若原文已是中文，headline 可微调润色，不要生硬直译。`;

export const SYSTEM_MILITARY = `你是一名资深军事观察编辑，面向中文读者解读国内外军事与防务新闻。
根据给定的标题和摘要写解读，不要编造标题里没有的事实，不要渲染仇恨或煽动对立。
只输出一个 JSON 对象，不要 markdown，不要代码块，字段如下：
{
  "headline": "中文标题，简洁有信息量，不超过 40 字",
  "takeaway": "一句话结论：这是什么事、涉及谁、为何值得关注，不超过 60 字",
  "bullets": ["要点1", "要点2", "要点3"],
  "detail": "中文补充说明，把原文摘要改写成 2～3 句白话，不超过 120 字"
}
bullets 2～4 条，每条不超过 40 字，说清发生了什么、相关方、可能影响。
detail 必须用中文；原文是英文时要翻译改写，不要照抄英文。
若原文已是中文，headline 可微调润色，不要生硬直译。`;

const SYSTEM = SYSTEM_AI;

/** 标题里中文字符占比高，视为中文内容（仍可做解读润色） */
export function mostlyChinese(text) {
  const s = String(text ?? '');
  if (!s) return false;
  const cjk = [...s].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
  return cjk / s.length >= 0.3;
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function normalizeInterpret(data) {
  const headline = String(data.headline ?? '').trim();
  const takeaway = String(data.takeaway ?? '').trim();
  const bullets = (Array.isArray(data.bullets) ? data.bullets : [])
    .map((b) => String(b).trim())
    .filter(Boolean)
    .slice(0, 4);
  const detail = String(data.detail ?? '').trim().slice(0, 160);
  if (!headline || !takeaway) throw new Error('解读字段不完整');
  return {
    headline,
    takeaway,
    bullets,
    ...(detail ? { detail } : {}),
    generatedAt: isoBeijing(),
  };
}

async function callDeepSeek(item, apiKey, timeoutMs, systemPrompt = SYSTEM) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              `分类：${item.category ?? '未知'}`,
              `来源：${item.source?.name ?? ''}`,
              `标题：${item.title}`,
              `摘要：${(item.summary ?? '').slice(0, 500) || '（无摘要）'}`,
            ].join('\n'),
          },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`);
    }

    const payload = await res.json();
    const content = payload.choices?.[0]?.message?.content;
    return normalizeInterpret(extractJson(content));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给一批条目生成中文解读。已有 interpret 的跳过。
 * 无 API Key 时直接返回原数组。失败的单条不影响其他。
 */
export async function interpretItems(items, config = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    log.info('未配置 DEEPSEEK_API_KEY，跳过中文解读');
    return items;
  }

  const minScore = config.interpretMinScore ?? 35;
  const maxPerRun = config.maxInterpretPerRun ?? 25;
  const concurrency = config.interpretConcurrency ?? 3;
  const timeoutMs = config.interpretTimeoutMs ?? 25000;
  const systemPrompt = config.interpretSystem ?? SYSTEM;

  const need = items
    .filter((i) => !i.interpret?.headline)
    .filter((i) => (i.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxPerRun);

  if (need.length === 0) return items;

  log.step(`生成中文解读 ${need.length} 条`);
  const byId = new Map(items.map((i) => [i.id, i]));
  let ok = 0;
  let fail = 0;

  await mapLimit(need, concurrency, async (item) => {
    try {
      const interpret = await callDeepSeek(item, apiKey, timeoutMs, systemPrompt);
      byId.set(item.id, { ...byId.get(item.id), interpret });
      ok++;
      log.ok(`解读 ${item.title.slice(0, 40)}`);
    } catch (err) {
      fail++;
      log.warn(`解读失败：${item.title.slice(0, 36)} — ${err.message}`);
    }
    await sleep(120);
  });

  log.info(`解读完成：成功 ${ok}，失败 ${fail}`);
  return items.map((i) => byId.get(i.id) ?? i);
}

/** 确保推送列表都有解读；缺的现场补，仍失败则带着原文推 */
export async function ensureInterpreted(items, config = {}) {
  return interpretItems(items, {
    ...config,
    interpretMinScore: 0,
    maxInterpretPerRun: items.length,
  });
}
