import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { compactCatalogue } from '../lib/catalogue-payload.ts';
test('smaller browser payload preserves every topic and stable relationship, leaving archive hashes on disk', () => {
  const source = readFileSync(
    new URL('../lib/catalogue-data.json', import.meta.url),
    'utf8',
  );
  const original = JSON.parse(source),
    smaller = compactCatalogue(source),
    compact = JSON.parse(smaller);
  assert.equal(compact.version, original.version);
  assert.equal(compact.nodes.length, 8335);
  assert.deepEqual(
    compact.nodes,
    original.nodes.map(({ revision, ...node }) => node),
  );
  assert.ok(original.nodes.every((n) => typeof n.revision === 'string'));
  assert.ok(gzipSync(smaller).length < gzipSync(source).length * 0.8);
});
