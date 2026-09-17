import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { classify, scoreItem, passesAiFilter, paperRank } from '../classify.js';
import { PIPELINE_DIR } from '../util.js';

const rules = JSON.parse(readFileSync(join(PIPELINE_DIR, 'rules.json'), 'utf8'));

const make = (title, { summary = '', type = 'ai', weight = 4, hoursOld = 1 } = {}) => ({
  title,
  summary,
  publishedAt: new Date(Date.now() - hoursOld * 3_600_000),
  source: { id: 's', name: '测试源', type, weight },
});

/* ---------- 分类 ---------- */

test('中英文都能分到正确的类', () => {
  assert.equal(classify(make('OpenAI 完成新一轮融资，估值超千亿美元'), rules).category, '融资并购');
  assert.equal(classify(make('Anthropic acquires a robotics startup'), rules).category, '融资并购');
  assert.equal(classify(make('英伟达发布新一代 GPU 芯片'), rules).category, '算力芯片');
  assert.equal(classify(make('欧盟通过 AI 法案，明确监管红线'), rules).category, '政策监管');
  assert.equal(classify(make('Meta open-sources its new model weights on GitHub'), rules).category, '开源工具');
});

test('论文源强制归入研究论文，不参与关键词竞争', () => {
  const paper = make('A Study on Funding Strategies for Chip Design', { type: 'paper', weight: 1 });
  assert.equal(classify(paper, rules).category, '研究论文');
});

test('Cursor 专属源强制归入 Cursor 类', () => {
  const item = make('Start from scratch, without a repo', { type: 'cursor', weight: 5 });
  assert.equal(classify(item, rules).category, 'Cursor');
});

test('其他源标题明确提到 Cursor IDE 时归入 Cursor', () => {
  assert.equal(classify(make('Cursor IDE adds background agents'), rules).category, 'Cursor');
  assert.equal(classify(make('Anysphere raises a new round'), rules).category, 'Cursor');
});

test('官方 Cursor 更新能越过 Cursor 推送线（40 分）', () => {
  const item = make('Cursor Projects now available', {
    type: 'cursor',
    weight: 5,
    hoursOld: 1,
    summary: 'Introducing Projects in the Cursor Changelog',
  });
  assert.ok(scoreItem(item, rules) >= 40, `实际得分 ${scoreItem(item, rules)}`);
});

test('英文按单词边界匹配，不会被词的一部分误命中', () => {
  // "banned" 是政策监管词，但 "abandoned" 不该命中
  const result = classify(make('A long abandoned research direction returns'), rules);
  assert.notEqual(result.category, '政策监管');
});

test('标题命中的权重高于摘要命中', () => {
  const inTitle = classify(make('OpenAI 宣布融资'), rules);
  const inSummary = classify(make('OpenAI 有新动向', { summary: '据传涉及融资' }), rules);
  assert.equal(inTitle.category, '融资并购');
  assert.ok(inTitle.confidence >= inSummary.confidence);
});

test('完全匹配不上任何分类时归入其他', () => {
  assert.equal(classify(make('今天天气不错'), rules).category, '其他');
});

/* ---------- 综合源的 AI 预筛 ---------- */

test('综合源里的非 AI 内容被挡掉', () => {
  const solar = make('东方日升三年累计裁员超60%，光伏行业依靠裁员抵抗下行周期', { type: 'general' });
  assert.equal(passesAiFilter(solar, rules), false);
});

test('综合源里标题带 AI 关键词的直接通过', () => {
  const ok = make('字节发布新一代大模型', { type: 'general' });
  assert.equal(passesAiFilter(ok, rules), true);
});

test('只在摘要里提一次 AI 的汇总贴不算 AI 新闻', () => {
  const digest = make('今日早报：多平台回应支付方式调整', {
    type: 'general',
    summary: '另外有消息称某公司将发布 AI 产品',
  });
  assert.equal(passesAiFilter(digest, rules), false);
});

test('摘要里出现两个以上 AI 关键词则通过', () => {
  const real = make('某公司公布季度财报', {
    type: 'general',
    summary: '财报显示其大模型业务增长，OpenAI 同期亦有类似表现',
  });
  assert.equal(passesAiFilter(real, rules), true);
});

test('AI 专属源与论文源不经过预筛', () => {
  assert.equal(passesAiFilter(make('随便什么标题', { type: 'ai' }), rules), true);
  assert.equal(passesAiFilter(make('随便什么标题', { type: 'paper' }), rules), true);
});

/* ---------- 打分标定 ---------- */

test('重磅发布能越过 60 分推送线', () => {
  const big = make('Introducing Gemini 3.8 with extended thinking', { weight: 5 });
  assert.ok(scoreItem(big, rules) >= 60, `实际得分 ${scoreItem(big, rules)}`);
});

test('官方账号的日常软文进不了推送线', () => {
  const fluff = make('Helping older adults use AI in everyday life', { weight: 5 });
  assert.ok(scoreItem(fluff, rules) < 60, `实际得分 ${scoreItem(fluff, rules)}`);
});

test('小工具的常规版本更新进不了推送线', () => {
  const minor = make('datasette 1.0a40 release', { weight: 4 });
  assert.ok(scoreItem(minor, rules) < 60, `实际得分 ${scoreItem(minor, rules)}`);
});

test('分数随时间衰减，48 小时后新鲜度归零', () => {
  const title = 'OpenAI launches GPT-5.5';
  assert.ok(scoreItem(make(title, { hoursOld: 1 }), rules) > scoreItem(make(title, { hoursOld: 30 }), rules));
  assert.equal(
    scoreItem(make(title, { hoursOld: 60 }), rules),
    scoreItem(make(title, { hoursOld: 100 }), rules)
  );
});

test('罗列大量公司名的文章不会靠主角分刷满', () => {
  const listicle = make('盘点：OpenAI、Anthropic、Google、Meta、英伟达、阿里、腾讯、百度的年度动作');
  assert.ok(scoreItem(listicle, rules) <= 100);
  const focused = make('OpenAI 发布新模型');
  // 罗列八家公司不应该比聚焦一家的重磅新闻分数高太多
  assert.ok(scoreItem(listicle, rules) - scoreItem(focused, rules) < 20);
});

test('分数恒在 0 到 100 之间', () => {
  for (const item of [make(''), make('a'.repeat(300)), make('OpenAI Anthropic 融资 开源 收购 突破 首个')]) {
    const s = scoreItem(item, rules);
    assert.ok(s >= 0 && s <= 100, `越界得分 ${s}`);
  }
});

/* ---------- 论文排序 ---------- */

test('有名机构且附代码的论文排序更靠前', () => {
  const strong = make('Scaling laws for reasoning, by DeepMind. Code: https://github.com/x/y', { type: 'paper' });
  const weak = make('An incremental tweak to an obscure method', { type: 'paper' });
  assert.ok(paperRank(strong, rules) > paperRank(weak, rules));
  assert.equal(paperRank(weak, rules), 0);
});
