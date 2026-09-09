import type { ChatUsage } from './ai-stream.ts';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'complete' | 'interrupted' | 'error';
  model?: string;
  usage?: ChatUsage;
};
export type TopicChat = {
  uid: string;
  revision: number;
  updatedAt: string;
  messages: ChatMessage[];
};
export const MAX_CHAT_MESSAGES = 400;
export const MAX_CHAT_CONTENT = 500_000;
export const MAX_CONTEXT_CHARS = 48_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const emptyChat = (uid: string): TopicChat => ({
  uid,
  revision: 0,
  updatedAt: '',
  messages: [],
});

/** Pick only known fields: provider credentials cannot enter chat backups. */
export function validateChat(value: unknown): TopicChat {
  if (!value || typeof value !== 'object') throw new Error('对话格式不正确');
  const v = value as TopicChat;
  if (
    !uuid.test(v.uid) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    typeof v.updatedAt !== 'string' ||
    !Array.isArray(v.messages) ||
    v.messages.length > MAX_CHAT_MESSAGES
  )
    throw new Error('对话记录不正确或过长');
  let size = 0;
  const ids = new Set<string>();
  const messages = v.messages.map((m): ChatMessage => {
    if (
      !m ||
      !uuid.test(m.id) ||
      ids.has(m.id) ||
      !['user', 'assistant'].includes(m.role) ||
      typeof m.content !== 'string' ||
      m.content.length > 64_000 ||
      typeof m.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(m.createdAt)) ||
      !['complete', 'interrupted', 'error'].includes(m.status)
    ) {
      throw new Error('对话消息不正确');
    }
    ids.add(m.id);
    size += m.content.length;
    const result: ChatMessage = {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      status: m.status,
    };
    if (typeof m.model === 'string') result.model = m.model.slice(0, 150);
    if (
      m.usage &&
      Number.isSafeInteger(m.usage.input) &&
      m.usage.input >= 0 &&
      Number.isSafeInteger(m.usage.output) &&
      m.usage.output >= 0
    )
      result.usage = { input: m.usage.input, output: m.usage.output };
    return result;
  });
  if (size > MAX_CHAT_CONTENT)
    throw new Error('本主题对话已较长，请导出留存后开始新对话');
  return { uid: v.uid, revision: v.revision, updatedAt: v.updatedAt, messages };
}

export function chatContext(messages: ChatMessage[], system: string) {
  const result: { role: 'system' | 'user' | 'assistant'; content: string }[] =
    [];
  let budget = MAX_CONTEXT_CHARS - system.length;
  let included = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.content || (m.role === 'assistant' && m.status !== 'complete'))
      continue;
    if (m.content.length > budget) break;
    result.unshift({ role: m.role, content: m.content });
    budget -= m.content.length;
    included++;
  }
  // Never start a truncated history halfway through an assistant response.
  while (result[0]?.role === 'assistant') result.shift();
  return {
    messages: [{ role: 'system' as const, content: system }, ...result],
    truncated:
      included <
      messages.filter((m) => m.content && m.status === 'complete').length,
  };
}

export function chatMarkdown(chat: TopicChat, title: string) {
  return (
    `# ${title} · AI 对话\n\n` +
    chat.messages
      .map(
        (m) =>
          `## ${m.role === 'user' ? '我' : 'AI'}${m.status !== 'complete' ? '（未完成）' : ''}\n\n${m.content}`,
      )
      .join('\n\n---\n\n')
  );
}

export function validateChatBackup(value: unknown): TopicChat[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error('对话备份格式不正确');
  const records = value.map(validateChat);
  if (new Set(records.map((r) => r.uid)).size !== records.length)
    throw new Error('备份里有重复的主题对话');
  return records;
}
