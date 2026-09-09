export type CatalogueEntry = {
  uid: string;
  code: string;
  title: string;
  parent: string | null;
  trackable: boolean;
};

export type CatalogueSection =
  | 'all'
  | 'thinking'
  | 'humanities'
  | 'society'
  | 'nature'
  | 'engineering'
  | 'living'
  | 'indexes';

export const catalogueSections: { id: CatalogueSection; label: string }[] = [
  { id: 'all', label: '全部领域' },
  { id: 'thinking', label: '思维与数字' },
  { id: 'humanities', label: '人文与艺术' },
  { id: 'society', label: '社会与商业' },
  { id: 'nature', label: '自然与生命' },
  { id: 'engineering', label: '工程与技术' },
  { id: 'living', label: '生活与实践' },
  { id: 'indexes', label: '交叉索引' },
];

export function sectionOf(code: string): CatalogueSection {
  if (!code.startsWith('K')) return 'indexes';
  const number = Number(code.slice(1, 3));
  if (number <= 6 || number === 48) return 'thinking';
  if (number <= 16) return 'humanities';
  if (number <= 26) return 'society';
  if (number <= 36) return 'nature';
  if (number === 37 || number >= 44) return 'living';
  return 'engineering';
}

export function levelEntries<T extends CatalogueEntry>(
  all: T[],
  scope: string | null,
  section: CatalogueSection = 'all',
): T[] {
  // Browsing always resolves just one level. Search is the only all-depth view.
  return all
    .filter(
      (entry) =>
        entry.parent === scope &&
        (scope !== null ||
          (section === 'all' && entry.code.startsWith('K')) ||
          sectionOf(entry.code) === section),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function paginate<T>(entries: T[], page: number, pageSize = 8) {
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), pages);
  return {
    items: entries.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    page: currentPage,
    pages,
    total: entries.length,
  };
}

export function categoryProgress(
  all: CatalogueEntry[],
  summaries: Record<string, { progress: number }>,
) {
  const byUid = new Map(all.map((entry) => [entry.uid, entry]));
  const parents = new Set(all.map((entry) => entry.parent));
  const result: Record<
    string,
    {
      total: number;
      completed: number;
      started: number;
      sum: number;
      average: number;
    }
  > = {};
  for (const entry of all) {
    if (!entry.trackable || parents.has(entry.uid)) continue;
    let parent = entry.parent;
    while (parent) {
      const stats = (result[parent] ||= {
        total: 0,
        completed: 0,
        started: 0,
        sum: 0,
        average: 0,
      });
      const progress = summaries[entry.uid]?.progress || 0;
      stats.total++;
      stats.sum += progress;
      stats.completed += Number(progress === 100);
      stats.started += Number(!!summaries[entry.uid]);
      parent = byUid.get(parent)?.parent || null;
    }
  }
  for (const stats of Object.values(result))
    stats.average = Math.round(stats.sum / stats.total);
  return result;
}
