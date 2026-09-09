/** Keep the archival catalogue intact; omit unused per-title hashes from browser builds. */
export function compactCatalogue(source: string): string {
  const data = JSON.parse(source) as {
    version: string;
    nodes: Record<string, unknown>[];
  };
  return JSON.stringify({
    ...data,
    nodes: data.nodes.map((node) => {
      const { revision: _archiveRevision, ...topic } = node;
      return topic;
    }),
  });
}
