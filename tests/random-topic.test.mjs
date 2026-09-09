import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomTopic } from '../lib/recommendations.ts';
const { nodes } = JSON.parse(
  readFileSync(new URL('../lib/catalogue-data.json', import.meta.url), 'utf8'),
);
const leaves = nodes.filter(
  (n) => n.trackable && !nodes.some((child) => child.parent === n.uid),
);
test('random draw changes the actual topic and domain, rather than rotating three starters', () => {
  const before = leaves[0];
  const next = randomTopic(nodes, {}, before.uid, [], () => 0);
  assert.notEqual(next.topic.uid, before.uid);
  assert.notEqual(next.topic.code.split('.')[0], before.code.split('.')[0]);
  const possible = new Set();
  for (let i = 0; i < 80; i++)
    possible.add(
      randomTopic(nodes, {}, before.uid, [], () => i / 80).topic.uid,
    );
  assert.ok(possible.size > 20);
});
test('completed and recently drawn topics are skipped when other choices remain', () => {
  const first = randomTopic(nodes, {}, null, [], () => 0);
  const second = randomTopic(nodes, {}, null, [first.topic.uid], () => 0);
  assert.notEqual(first.topic.uid, second.topic.uid);
  const third = randomTopic(
    nodes,
    { [first.topic.uid]: { progress: 100 } },
    null,
    [],
    () => 0,
  );
  assert.notEqual(first.topic.uid, third.topic.uid);
});
test('only one remaining theme never loops back to itself and no topic is fabricated', () => {
  const small = leaves.slice(0, 2);
  assert.equal(
    randomTopic(small, { [small[1].uid]: { progress: 100 } }, small[0].uid),
    null,
  );
  assert.equal(randomTopic([], {}), null);
});
