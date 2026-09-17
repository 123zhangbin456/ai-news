import { hoursAgo } from './util.js';

/* ---------- 匹配基元 ---------- */

const regexCache = new Map();

/** 英文按单词边界匹配，避免 "agent" 命中 "agenda"、"AI" 命中 "said" */
function enRegex(word) {
  let re = regexCache.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    regexCache.set(word, re);
  }
  return re;
}

const hitZh = (text, word) => text.includes(word);
const hitEn = (text, word) => enRegex(word).test(text);

/* ---------- 综合源的 AI 预筛 ---------- */

/**
 * 钛媒体、开源中国这类综合源什么都发，不筛的话光伏新闻和 Java 版本更新会淹没内容。
 * AI 专属源和论文源不走这里。
 *
 * 标题命中即通过；只在摘要里提到则要求至少两个不同关键词——雷锋网的"早报"
 * 汇总里顺带提一句 AI 的情况很多，单个词不足以说明这是条 AI 新闻。
 */
export function passesAiFilter(item, rules) {
  if (item.source?.type !== 'general') return true;

  const title = item.title ?? '';
  const summary = item.summary ?? '';
  const titleLower = title.toLowerCase();
  const summaryLower = summary.toLowerCase();

  const inTitle =
    rules.aiFilter.zh.some((w) => hitZh(title, w)) ||
    rules.aiFilter.en.some((w) => hitEn(titleLower, w));
  if (inTitle) return true;

  // 按词去重再计数："AI" 同时出现在中英文两份清单里，不去重会让单个词凑够两票
  const matched = new Set();
  for (const w of rules.aiFilter.zh) if (hitZh(summary, w)) matched.add(w.toLowerCase());
  for (const w of rules.aiFilter.en) if (hitEn(summaryLower, w)) matched.add(w.toLowerCase());
  return matched.size >= 2;
}

/* ---------- 分类 ---------- */

/**
 * 每个分类累加命中关键词的权重，最高者胜出。
 * 标题命中算双倍——标题里出现"融资"比正文里提一句可信得多。
 */
export function classify(item, rules) {
  if (item.source?.type === 'paper') {
    return { category: '研究论文', keywords: ['arXiv'], confidence: 1 };
  }

  const title = item.title ?? '';
  const summary = item.summary ?? '';
  const titleLower = title.toLowerCase();
  const summaryLower = summary.toLowerCase();

  let best = null;
  let runnerUp = 0;

  for (const cat of rules.categories) {
    let score = 0;
    const hits = [];

    for (const [word, weight] of Object.entries(cat.zh)) {
      if (hitZh(title, word)) { score += weight * 2; hits.push(word); }
      else if (hitZh(summary, word)) { score += weight; hits.push(word); }
    }
    for (const [word, weight] of Object.entries(cat.en)) {
      if (hitEn(titleLower, word)) { score += weight * 2; hits.push(word); }
      else if (hitEn(summaryLower, word)) { score += weight; hits.push(word); }
    }

    if (!best || score > best.score) {
      runnerUp = best?.score ?? 0;
      best = { category: cat.name, score, keywords: [...new Set(hits)].slice(0, 6) };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || best.score === 0) {
    return { category: '其他', keywords: [], confidence: 0 };
  }

  return {
    category: best.category,
    keywords: best.keywords,
    // 与第二名拉开差距才算分得清楚。低置信度的条目将来交给 LLM 兜底
    confidence: Number(((best.score - runnerUp) / best.score).toFixed(2)),
  };
}

/* ---------- 重要度打分 ---------- */

/** 收集一组带权词的命中值，标题算满分、摘要减半 */
function collectHits(wordSets, title, summary) {
  const titleLower = title.toLowerCase();
  const summaryLower = summary.toLowerCase();
  const hits = [];

  for (const [word, weight] of Object.entries(wordSets.zh)) {
    if (hitZh(title, word)) hits.push(weight);
    else if (hitZh(summary, word)) hits.push(weight / 2);
  }
  for (const [word, weight] of Object.entries(wordSets.en)) {
    if (hitEn(titleLower, word)) hits.push(weight);
    else if (hitEn(summaryLower, word)) hits.push(weight / 2);
  }
  return hits.sort((a, b) => b - a);
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

/**
 * 0-100，四块构成：
 *   来源可信度 25 + 事件信号 30 + 主角分量 25 + 新鲜度 20
 *
 * 标定目标：官方账号发的日常软文进不了 60，"Introducing Gemini" 这类要进得去。
 * 单看来源或单看关键词都会误判，四项叠加才能拉开差距。
 */
export function scoreItem(item, rules, now = new Date()) {
  const title = item.title ?? '';
  const summary = item.summary ?? '';

  const sourceScore = (item.source?.weight ?? 1) * 5;

  const signalScore = Math.min(30, sum(collectHits(rules.signalWords, title, summary)) * 1.5);

  // 只取最强的 3 个主角，否则"盘点十家 AI 公司"这类文章会无脑刷满
  const entityScore = Math.min(25, sum(collectHits(rules.entityWords, title, summary).slice(0, 3)));

  const age = item.publishedAt ? hoursAgo(item.publishedAt, now) : 24;
  const freshScore = age <= 3 ? 20 : age >= 48 ? 0 : 20 * (1 - (age - 3) / 45);

  return Math.max(0, Math.min(100, Math.round(sourceScore + signalScore + entityScore + freshScore)));
}

/* ---------- arXiv 论文排序 ---------- */

/**
 * 每天 450+ 篇论文，晨报只放得下 5 篇。
 * 按机构知名度、是否附代码、话题热度挑出最值得看的。
 */
export function paperRank(item, rules) {
  const boost = rules.paperBoost;
  const text = `${item.title} ${item.summary ?? ''}`;
  const lower = text.toLowerCase();
  let rank = 0;

  for (const [org, weight] of Object.entries(boost.institutions)) {
    if (org.match(/[\u4e00-\u9fff]/) ? hitZh(text, org) : hitEn(lower, org)) rank += weight;
  }
  if (/github\.com|https?:\/\/\S*\/code|project page/i.test(text)) rank += boost.hasCodeLink;
  for (const [topic, weight] of Object.entries(boost.hotTopics)) {
    if (lower.includes(topic.toLowerCase())) rank += weight;
  }
  return rank;
}

/** 给一批条目补齐 category / score / keywords 字段 */
export function enrich(items, rules, now = new Date()) {
  return items.map((item) => {
    const { category, keywords, confidence } = classify(item, rules);
    return {
      ...item,
      category,
      keywords,
      confidence,
      score: scoreItem(item, rules, now),
      paperRank: item.source?.type === 'paper' ? paperRank(item, rules) : undefined,
    };
  });
}
