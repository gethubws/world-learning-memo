import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatStore } from '../lib/chat-store.ts';
import {
  emptyChat,
  validateChat,
  validateChatBackup,
  chatContext,
  chatMarkdown,
} from '../lib/topic-chat.ts';
import { validateBackup, emptyMemo, contentOf } from '../lib/records.ts';
import { sseData, consumeAiStream } from '../lib/ai-stream.ts';
const uid = '11111111-1111-4111-8111-111111111111';
const message = (role, content, status = 'complete') => ({
  id: crypto.randomUUID(),
  role,
  content,
  status,
  createdAt: new Date().toISOString(),
});
test('topic conversations survive reopening and do not change memo progress', async () => {
  const factory = new IDBFactory();
  const first = createChatStore(factory);
  const saved = await first.write(
    {
      ...emptyChat(uid),
      messages: [
        message('user', '怎么演奏？'),
        message('assistant', '先从节奏练习开始'),
      ],
    },
    0,
  );
  assert.deepEqual(await createChatStore(factory).get(uid), saved);
  assert.equal(emptyMemo(uid).progress, 0);
  const copy = validateChatBackup(JSON.parse(JSON.stringify([saved])));
  const restored = createChatStore(new IDBFactory());
  await restored.write(copy[0], 0);
  assert.deepEqual((await restored.get(uid)).messages, saved.messages);
});
test('concurrent writes cannot overwrite a conversation from another tab', async () => {
  const factory = new IDBFactory();
  const a = createChatStore(factory),
    b = createChatStore(factory);
  const chat = { ...emptyChat(uid), messages: [message('user', '问题')] };
  const outcomes = await Promise.allSettled([
    a.write(chat, 0),
    b.write(chat, 0),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(
    outcomes.find((r) => r.status === 'rejected').reason.message,
    /另一页面/,
  );
});
test('partial answers are retained and interrupted answers are not sent as complete context', () => {
  const chat = {
    ...emptyChat(uid),
    messages: [
      message('user', '问题'),
      message('assistant', '部分回答', 'interrupted'),
    ],
  };
  assert.match(chatMarkdown(chat, '音乐'), /部分回答/);
  const context = chatContext(chat.messages, '教学助手');
  assert.deepEqual(
    context.messages.map((m) => m.role),
    ['system', 'user'],
  );
});
test('context keeps recent questions within bounds and makes truncation explicit', () => {
  const messages = Array.from({ length: 20 }, (_, i) =>
    message(i % 2 ? 'assistant' : 'user', String(i) + '文'.repeat(5000)),
  );
  messages.push(message('user', '我最新的问题'));
  const result = chatContext(messages, '参考主题');
  assert.ok(result.truncated);
  assert.equal(result.messages.at(-1).content, '我最新的问题');
  assert.equal(result.messages[1].role, 'user');
  assert.ok(result.messages.reduce((n, m) => n + m.content.length, 0) <= 48000);
});
test('backup validation drops credential fields and accepts v1 and v2 memo backups', () => {
  const chat = validateChat({
    ...emptyChat(uid),
    key: 'DO-NOT-EXPORT',
    messages: [{ ...message('user', '普通文字'), apiKey: 'DO-NOT-EXPORT' }],
  });
  assert.ok(!JSON.stringify(chat).includes('DO-NOT-EXPORT'));
  for (const schemaVersion of [1, 2])
    assert.equal(
      validateBackup({
        format: 'world-learning-memo',
        schemaVersion,
        records: [contentOf(emptyMemo(uid))],
      }).length,
      1,
    );
  assert.deepEqual(validateChatBackup(undefined), []);
  assert.throws(() => validateChatBackup([chat, chat]), /重复/);
  assert.throws(() =>
    validateChat({ ...chat, messages: [message('system', 'untrusted')] }),
  );
});
test('SSE decoding preserves Chinese and multiline events at every byte boundary', async () => {
  const text =
    'data: {"text":"琴🎵"}\r\n\r\ndata: first\ndata: second\n\ndata: [DONE]\n\n';
  async function* chunks() {
    for (const byte of new TextEncoder().encode(text))
      yield new Uint8Array([byte]);
  }
  const events = [];
  for await (const event of sseData(chunks())) events.push(event);
  assert.deepEqual(events, ['{"text":"琴🎵"}', 'first\nsecond', '[DONE]']);
});
test('client retains emitted text but detects a stream that disappears before done', async () => {
  const events = [];
  await assert.rejects(
    consumeAiStream(
      new Response('data: {"type":"text","text":"已收到"}\n\n'),
      (e) => events.push(e),
    ),
    /连接中断/,
  );
  assert.equal(events[0].text, '已收到');
  await consumeAiStream(
    new Response('data: {"type":"done","reason":"stop"}\n\n'),
    () => {},
  );
});
