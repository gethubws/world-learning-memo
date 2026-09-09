import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recommendTopics, subtopicProgress } from '../lib/recommendations.ts';

const { nodes } = JSON.parse(
  readFileSync(new URL('../lib/catalogue-data.json', import.meta.url), 'utf8'),
);
const topic = (code) => nodes.find((node) => node.code === code);
const summary = (node, progress, updatedAt = '2026-09-08T01:00:00Z') => ({
  uid: node.uid,
  title: '',
  hasNote: false,
  progress,
  updatedAt,
});

test('cold start suggests three real, independent leaf topics without modifying the catalogue', () => {
  const snapshot = JSON.stringify(nodes);
  const recommendations = recommendTopics(nodes, {});
  assert.equal(recommendations.length, 3);
  assert.equal(new Set(recommendations.map(({ topic }) => topic.uid)).size, 3);
  for (const { topic } of recommendations) {
    assert.equal(topic.trackable, true);
    assert.equal(
      nodes.some((node) => node.parent === topic.uid),
      false,
    );
  }
  assert.equal(JSON.stringify(nodes), snapshot);
});

test('recent unfinished records, including notes with zero progress, come first', () => {
  const a = topic('K18.16.01');
  const b = topic('K45.04.01');
  const summaries = {
    [a.uid]: summary(a, 25),
    [b.uid]: { ...summary(b, 0, '2026-09-08T02:00:00Z'), hasNote: true },
  };
  const snapshot = JSON.stringify(summaries);
  const recs = recommendTopics(nodes, summaries);
  assert.deepEqual(
    recs.slice(0, 2).map(({ topic }) => topic.uid),
    [b.uid, a.uid],
  );
  assert.equal(JSON.stringify(summaries), snapshot);
});

test('completed, unknown and currently open records are excluded', () => {
  const a = topic('K18.16.01');
  const b = topic('K12.04.16.01');
  const c = topic('K45.04.01');
  const recs = recommendTopics(
    nodes,
    {
      [a.uid]: summary(a, 100),
      [b.uid]: summary(b, 100),
      unknown: {
        ...summary(a, 20),
        uid: 'unknown',
        updatedAt: '2026-09-09T00:00:00Z',
      },
    },
    c.uid,
  );
  assert.equal(recs.length, 3);
  for (const { topic } of recs) {
    assert.ok(![a.uid, b.uid, c.uid, 'unknown'].includes(topic.uid));
  }
});

test('after completing a parent, recommend an unstarted child without inheriting completion', () => {
  const parent = topic('K03.03.02');
  const recs = recommendTopics(nodes, { [parent.uid]: summary(parent, 100) });
  assert.equal(recs[0].topic.parent, parent.uid);
  assert.ok(recs[0].topic.trackable);
});

test('a completed catalogue has no fabricated recommendations', () => {
  const one = topic('K18.16.01');
  assert.deepEqual(
    recommendTopics([one], { [one.uid]: summary(one, 100) }),
    [],
  );
});

test('child progress counts unstarted children as zero and does not inherit parent progress', () => {
  const parent = topic('K03.03.02');
  const children = nodes.filter((node) => node.parent === parent.uid);
  const summaries = {
    [parent.uid]: summary(parent, 100),
    [children[0].uid]: summary(children[0], 100),
    [children[1].uid]: summary(children[1], 50),
  };
  assert.deepEqual(subtopicProgress(children, summaries), {
    total: 3,
    completed: 1,
    average: 50,
  });
  assert.deepEqual(
    subtopicProgress(children, { [parent.uid]: summary(parent, 100) }),
    { total: 3, completed: 0, average: 0 },
  );
  assert.deepEqual(subtopicProgress([], summaries), {
    total: 0,
    completed: 0,
    average: 0,
  });
});
