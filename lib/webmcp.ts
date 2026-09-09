import { nodeMap, nodes, pathOf, teachingPrompt } from './catalogue';
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};
export function registerMemoTools() {
  const context = (
    document as Document & {
      modelContext?: {
        registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown;
      };
    }
  ).modelContext;
  if (!context?.registerTool) return;
  const controller = new AbortController();
  const tools: Tool[] = [
    {
      name: 'search_learning_topics',
      description:
        'Search this catalogue and return up to 20 precise topic IDs with their full paths.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const a = input as { query?: unknown };
        if (
          !a ||
          typeof a.query !== 'string' ||
          !a.query.trim() ||
          a.query.length > 100
        )
          throw new Error('query required');
        const q = a.query.trim().toLowerCase();
        return nodes
          .filter(
            (n) =>
              n.trackable &&
              `${n.code} ${n.title} ${pathOf(n)
                .map((p) => p.title)
                .join(' ')}`
                .toLowerCase()
                .includes(q),
          )
          .slice(0, 20)
          .map((n) => ({
            uid: n.uid,
            title: n.title,
            path: pathOf(n)
              .map((p) => p.title)
              .join(' → '),
          }));
      },
    },
    {
      name: 'read_learning_prompt',
      description:
        'Read the teaching prompt for a catalogue topic. Does not mark progress or copy to the clipboard.',
      inputSchema: {
        type: 'object',
        properties: { uid: { type: 'string' } },
        required: ['uid'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const uid = (input as { uid?: unknown })?.uid;
        const n = typeof uid === 'string' ? nodeMap.get(uid) : undefined;
        if (!n?.trackable) throw new Error('Unknown learning topic');
        return { uid: n.uid, prompt: teachingPrompt(n, n.title) };
      },
    },
  ];
  for (const t of tools) {
    try {
      Promise.resolve(
        context.registerTool(t, { signal: controller.signal }),
      ).catch(() => {});
    } catch {
      /* Optional browser capability. */
    }
  }
  return () => controller.abort();
}
