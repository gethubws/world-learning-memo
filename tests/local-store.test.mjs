import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalMemoStore,
  localApi,
  LOCAL_PROFILE,
} from '../lib/local-store.ts';
import { contentOf, emptyMemo, validateBackup } from '../lib/records.ts';
const uid = '11111111-1111-4111-8111-111111111111';
const memo = (title = '我的练习') => ({
  ...contentOf(emptyMemo(uid)),
  title,
  progress: 35,
  note: '中文聊天\n```js\nconst x = "<原文>";\n```',
  points: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: '演奏练习',
      done: true,
    },
  ],
});
test('a device retains complete records across connections with no account or network', async () => {
  const factory = new IDBFactory();
  const first = createLocalMemoStore(factory),
    second = createLocalMemoStore(factory);
  assert.equal((await first.get(uid)).revision, 0);
  const saved = await first.write(memo(), 0);
  assert.deepEqual(contentOf(await second.get(uid)), memo());
  assert.equal(saved.revision, 1);
  const summaries = await second.summaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].hasNote, true);
  assert.equal(summaries[0].progress, 35);
  assert.equal('note' in summaries[0], false);
});
test('another device starts separately, without reading the first device notes', async () => {
  const a = createLocalMemoStore(new IDBFactory()),
    b = createLocalMemoStore(new IDBFactory());
  await a.write(memo(), 0);
  assert.deepEqual(await b.summaries(), []);
  assert.equal((await b.get(uid)).note, '');
});
test('competing tab writes are atomic: one succeeds and the other gets the saved version', async () => {
  const factory = new IDBFactory();
  const a = createLocalMemoStore(factory),
    b = createLocalMemoStore(factory);
  await a.write(memo(), 0);
  const results = await Promise.allSettled([
    a.write(memo('A'), 1),
    b.write(memo('B'), 1),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failure = results.find((r) => r.status === 'rejected').reason;
  assert.equal(failure.status, 409);
  assert.equal(failure.data.current.revision, 2);
  const saved = await a.get(uid),
    summary = (await b.summaries())[0];
  assert.equal(saved.title, summary.title);
  assert.equal(summary.revision, 2);
});
test('invalid data and importing an existing ID cannot replace existing progress or notes', async () => {
  const store = createLocalMemoStore(new IDBFactory());
  const saved = await store.write(memo(), 0);
  await assert.rejects(store.write({ ...memo(), progress: 999 }, 1));
  await assert.rejects(store.write({ ...memo(), note: 'a'.repeat(200001) }, 1));
  await assert.rejects(
    store.write(memo('来自备份的同名记录'), 0),
    (e) => e.status === 409,
  );
  assert.deepEqual(await store.get(uid), saved);
});
test('paged export and import preserve all 25 records and the existing backup format', async () => {
  const source = createLocalMemoStore(new IDBFactory()),
    target = createLocalMemoStore(new IDBFactory());
  for (let i = 0; i < 25; i++)
    await source.write(
      {
        ...memo(),
        uid: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      },
      0,
    );
  const records = [];
  let cursor = '';
  do {
    const page = await source.page(cursor);
    assert.ok(page.records.length <= 10);
    records.push(...page.records.map(contentOf));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(records.map((r) => r.uid)).size, 25);
  for (const record of validateBackup({
    format: 'world-learning-memo',
    schemaVersion: 1,
    records,
  }))
    await target.write(record, 0);
  assert.deepEqual(
    (await target.page()).records.map(contentOf),
    records.slice(0, 10),
  );
});
test('normal editor operations never fetch the private API', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network must not be used');
  };
  try {
    const state = await localApi('/api/memos');
    assert.equal(state.profile, LOCAL_PROFILE);
    await localApi('/api/memos', {
      method: 'POST',
      body: JSON.stringify({ record: memo(), expectedRevision: 0 }),
    });
    const saved = await localApi('/api/memos?topic=' + uid);
    assert.equal(saved.record.note, memo().note);
    assert.equal((await localApi('/api/memos?export=1')).records.length, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
