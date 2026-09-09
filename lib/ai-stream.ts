/** Decode SSE across arbitrary UTF-8 and network chunk boundaries. */
export async function* sseData(source: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [];
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_000_000) throw new Error('AI 返回的数据过大');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  if (data.length) yield data.join('\n');
}

export type ChatUsage = { input: number; output: number };
export type AiEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string };

export async function consumeAiStream(
  response: Response,
  onEvent: (event: AiEvent) => void,
) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'AI 服务暂时不可用，请稍后重试');
  }
  if (!response.body) throw new Error('浏览器不支持流式回复');
  const reader = response.body.getReader();
  const source = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
  let finished = false;
  for await (const data of sseData(source)) {
    const event = JSON.parse(data) as AiEvent;
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') finished = true;
    onEvent(event);
  }
  if (!finished) throw new Error('连接中断，已保留收到的内容；可点击重试');
}
