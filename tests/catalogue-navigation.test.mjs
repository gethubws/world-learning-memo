import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  levelEntries,
  paginate,
  catalogueSections,
  categoryProgress,
} from '../lib/catalogue-navigation.ts';
import {
  domainPresentation,
  featuredDomains,
} from '../lib/domain-presentation.ts';

const { nodes } = JSON.parse(
  readFileSync(new URL('../lib/catalogue-data.json', import.meta.url), 'utf8'),
);

test('root browsing only shows the 48 domains, without flattening thousands of topics', () => {
  const roots = levelEntries(nodes, null);
  assert.equal(roots.length, 48);
  assert.ok(roots.every((n) => n.parent === null && /^K\d\d$/.test(n.code)));
  assert.equal(paginate(roots, 1).items.length, 8);
});

test('every existing node remains reachable by one-level navigation, including indexes', () => {
  const seen = new Set();
  const visit = (n) => {
    assert.ok(!seen.has(n.uid), `Duplicate visit: ${n.code}`);
    seen.add(n.uid);
    const children = levelEntries(nodes, n.uid);
    assert.ok(children.every((child) => child.parent === n.uid));
    children.forEach(visit);
  };
  [
    ...levelEntries(nodes, null),
    ...levelEntries(nodes, null, 'indexes'),
  ].forEach(visit);
  assert.equal(seen.size, nodes.length);
});

test('category groups partition the complete root directory without losing or duplicating entries', () => {
  const groups = catalogueSections
    .filter((section) => section.id !== 'all')
    .flatMap((section) => levelEntries(nodes, null, section.id));
  assert.equal(groups.length, nodes.filter((n) => !n.parent).length);
  assert.equal(new Set(groups.map((n) => n.uid)).size, groups.length);
});

test('pagination reaches every item exactly once and clamps after a filter reduces the result', () => {
  const entries = levelEntries(nodes, null);
  const allPages = [];
  for (let page = 1; page <= paginate(entries, 1).pages; page++) {
    const result = paginate(entries, page);
    assert.ok(result.items.length <= 8);
    allPages.push(...result.items);
  }
  assert.deepEqual(allPages, entries);
  assert.equal(paginate(entries.slice(0, 2), 6).page, 1);
  assert.deepEqual(paginate([], 99), {
    items: [],
    page: 1,
    pages: 1,
    total: 0,
  });
});

test('every domain has its own label and icon and all six homepage entries exist', () => {
  const domains = levelEntries(nodes, null);
  assert.equal(
    new Set(domains.map((n) => domainPresentation(n.code).name)).size,
    48,
  );
  for (const n of domains) assert.ok(domainPresentation(n.code).Icon);
  assert.equal(featuredDomains.length, 6);
  for (const code of featuredDomains)
    assert.ok(domains.find((n) => n.code === code));
});

test('category rollups use leaf records, so a completed parent cannot complete its children', () => {
  const parent = nodes.find((n) => n.code === 'K03.03.02');
  const children = levelEntries(nodes, parent.uid);
  const onlyParent = categoryProgress(nodes, {
    [parent.uid]: { progress: 100 },
  });
  assert.equal(onlyParent[parent.uid].average, 0);
  const result = categoryProgress(nodes, {
    [parent.uid]: { progress: 100 },
    [children[0].uid]: { progress: 100 },
    [children[1].uid]: { progress: 50 },
  });
  assert.deepEqual(result[parent.uid], {
    total: 3,
    completed: 1,
    started: 2,
    sum: 150,
    average: 50,
  });
});
