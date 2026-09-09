import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMemo,
  validateBackup,
  extractHeadings,
  emptyMemo,
  contentOf,
} from '../lib/records.ts';
const uid = '11111111-1111-4111-8111-111111111111';
const point = '22222222-2222-4222-8222-222222222222';
const memo = () => ({
  ...contentOf(emptyMemo(uid)),
  note: '中文\n```js\nalert("原文");\n```\n<script>文本</script>',
});
test('backup round trip preserves full chat text and completion', () => {
  const m = {
    ...memo(),
    progress: 65,
    title: '我的标题',
    points: [{ id: point, title: '练习一', done: true }],
  };
  assert.deepEqual(
    validateBackup(
      JSON.parse(
        JSON.stringify({
          format: 'world-learning-memo',
          schemaVersion: 1,
          records: [m],
        }),
      ),
    ),
    [m],
  );
});
test('invalid percentages and unknown fields are rejected', () => {
  for (const progress of [-1, 101, NaN, 3.5, true])
    assert.throws(() => validateMemo({ ...memo(), progress }));
  assert.throws(() => validateMemo({ ...memo(), userId: 'spoof' }));
});
test('duplicate point identities and invalid payloads cannot corrupt a record', () => {
  const p = { id: point, title: '知识点', done: false };
  assert.throws(() => validateMemo({ ...memo(), points: [p, p] }));
  assert.throws(() =>
    validateMemo({ ...memo(), points: [{ ...p, done: 'true' }] }),
  );
  assert.throws(() =>
    validateMemo({ ...memo(), points: [{ ...p, title: '' }] }),
  );
});
test('heading extraction ignores code and duplicates while preserving input', () => {
  const text = '# 入门\n```md\n# 代码中的标题\n```\n## 演奏\n## 演奏\n普通对话';
  const snapshot = text;
  assert.deepEqual(extractHeadings(text, ['入门']), ['演奏']);
  assert.equal(text, snapshot);
});
test('nested examples inside a longer code fence cannot become knowledge points', () => {
  const text =
    '# 应保留\n````md\n```js\n# 示例中的标题\n```\n## 仍在示例里\n````\n## 也保留';
  assert.deepEqual(extractHeadings(text, []), ['应保留', '也保留']);
});
test('one large chat and escaped control characters respect storage bounds', () => {
  assert.throws(() => validateMemo({ ...memo(), note: '中'.repeat(200001) }));
  assert.throws(() => validateMemo({ ...memo(), note: '\0'.repeat(200000) }));
  assert.equal(
    validateMemo({ ...memo(), note: '中'.repeat(200000) }).note.length,
    200000,
  );
});
test('a repeated backup ID or foreign backup is rejected before import', () => {
  assert.throws(() =>
    validateBackup({
      format: 'world-learning-memo',
      schemaVersion: 1,
      records: [memo(), memo()],
    }),
  );
  assert.throws(() =>
    validateBackup({ format: 'other', schemaVersion: 1, records: [] }),
  );
});
