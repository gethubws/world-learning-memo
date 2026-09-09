import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeachingPrompt } from '../lib/learning-prompt.ts';
const base = {
  code: 'K03.03.02',
  title: '证明方法',
  originalTitle: '证明方法',
  path: ['数学', '数学推理', '证明方法'],
  version: '0.3.0',
  outline: [
    { code: 'K03.03.02.01', title: '直接证明的假设与推导链', depth: 1 },
    { code: 'K03.03.02.02', title: '分情况证明的完备性', depth: 1 },
    { code: 'K03.03.02.03', title: '构造对象并验证条件', depth: 1 },
  ],
  personalPoints: [],
};
test('a copied parent includes every numbered descendant and context', () => {
  const text = buildTeachingPrompt(base);
  for (const n of base.outline)
    assert.ok(text.includes(`${n.code} ${n.title}`));
  assert.ok(text.includes('数学 → 数学推理 → 证明方法'));
  assert.ok(text.includes('0.3.0'));
  assert.ok(text.includes('可调整的知识地图'));
  assert.ok(text.includes('不要每轮固定测验'));
  assert.ok(text.includes('我随时可以改变方向'));
});
test('a renamed topic retains its original meaning for the tutor', () => {
  const text = buildTeachingPrompt({ ...base, title: '我的证明练习' });
  assert.ok(text.includes('主题：我的证明练习'));
  assert.ok(text.includes('原目录标题：证明方法'));
});
test('an unsplit topic asks for a scope check and does not pretend it is exhaustive', () => {
  const text = buildTeachingPrompt({ ...base, outline: [] });
  assert.ok(text.includes('暂未预编更细目录'));
  assert.ok(text.includes('不能据此声称穷尽所有知识'));
  assert.ok(text.includes('一次试探、看图或小 Demo 不自动算作掌握'));
});
test('long outlines explicitly identify truncation rather than silently omit topics', () => {
  const outline = Array.from({ length: 201 }, (_, i) => ({
    code: `K03.03.02.${i + 1}`,
    title: `题目${i + 1}`,
    depth: 1,
  }));
  const text = buildTeachingPrompt({ ...base, outline });
  assert.ok(text.includes('201 条'));
  assert.ok(text.includes('前 200 条'));
  assert.ok(text.includes('不要声称已经覆盖完整个主题'));
  assert.ok(!text.includes('- K03.03.02.201 '));
});
test('media autonomy is bounded by real tools and evidence, with archiving only at a pause', () => {
  const text = buildTeachingPrompt(base);
  assert.ok(text.includes('按你实际拥有的工具行动'));
  assert.ok(text.includes('不要把未运行的代码说成已验证'));
  assert.ok(text.includes('阶段暂停或我要求归档时'));
  assert.ok(text.includes('实际完成的解释或实践及其证据'));
  assert.ok(text.includes('缺失素材明确标注'));
  assert.ok(!text.includes('每轮末尾简列'));
});
test('personal points are deduplicated without changing the source or marking progress', () => {
  const source = {
    ...base,
    personalPoints: [' 判断条件 ', '判断条件', '', '找反例'],
  };
  const before = structuredClone(source);
  const text = buildTeachingPrompt(source);
  assert.equal(text.split('- 判断条件').length - 1, 1);
  assert.ok(text.includes('- 找反例'));
  assert.deepEqual(source, before);
});
