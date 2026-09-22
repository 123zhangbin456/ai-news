import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathsFor } from '../store.js';
import { passesAiFilter, classify } from '../classify.js';
import { PIPELINE_DIR, readJSON } from '../util.js';

test('pathsFor：军事主题写入 data/military/military/', () => {
  const p = pathsFor('military');
  assert.equal(p.domain, 'military');
  assert.equal(p.topic, 'military');
  assert.match(p.day('2026-09-22'), /data\/military\/military\/2026-09-22\.json$/);
});

test('pathsFor：农民工仍在 data/policy/migrant/', () => {
  const p = pathsFor('migrant');
  assert.equal(p.domain, 'policy');
  assert.match(p.day('2026-09-22'), /data\/policy\/migrant\/2026-09-22\.json$/);
});

test('军事 topicFilter 筛掉无关综合源标题', async () => {
  const rules = await readJSON(join(PIPELINE_DIR, 'military-rules.json'));
  const mil = {
    title: '美军在台海举行联合军演',
    summary: '',
    source: { type: 'general' },
  };
  const food = {
    title: '本季水果价格回落',
    summary: '市场供应充足',
    source: { type: 'general' },
  };
  assert.equal(passesAiFilter(mil, rules), true);
  assert.equal(passesAiFilter(food, rules), false);
});

test('军事专属源不走关键词预筛', async () => {
  const rules = await readJSON(join(PIPELINE_DIR, 'military-rules.json'));
  assert.equal(
    passesAiFilter({ title: '随便什么标题', source: { type: 'topic' } }, rules),
    true
  );
});

test('军事分类可识别装备与冲突', async () => {
  const rules = await readJSON(join(PIPELINE_DIR, 'military-rules.json'));
  const gear = classify(
    { title: '新型隐身战机完成试飞列装', summary: '航母配套', source: { type: 'topic' } },
    rules
  );
  const war = classify(
    { title: '加沙地带再遭空袭', summary: '哈马斯与以军交火', source: { type: 'topic' } },
    rules
  );
  assert.equal(gear.category, '装备动态');
  assert.equal(war.category, '国际冲突');
});
