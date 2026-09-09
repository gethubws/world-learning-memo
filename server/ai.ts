import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sseData } from '../lib/ai-stream.ts';

const SESSION_MS = 2 * 60 * 60 * 1000;
const MAX_BODY = 240_000;
const COOKIE = 'memo_ai_session';
type Session = {
  key: string;
  baseUrl: string;
  model: string;
  expiresAt: number;
  requests: number[];
  active: Set<AbortController>;
};
type ProviderResponse = { status: number; body: AsyncIterable<Uint8Array> };
type ProviderRequest = {
  url: URL;
  key: string;
  body: string;
  signal: AbortSignal;
};
type Options = {
  origin?: string;
  allowedBases?: string[];
  now?: () => number;
  provider?: (input: ProviderRequest) => Promise<ProviderResponse>;
};
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function normalizeBase(value: unknown) {
  if (typeof value !== 'string') throw new ApiError(400, '请输入 API 地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'API 地址不正确');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.localhost')
  )
    throw new ApiError(
      400,
      'API 地址必须是公开服务的 HTTPS 地址，不含账号、参数或端口',
    );
  return url.href.replace(/\/+$/, '');
}
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  // Only global unicast; exclude transition, documentation and reserved ranges.
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return (
      /^[23][0-9a-f]{0,3}:/.test(a) &&
      !a.startsWith('2001:') &&
      !a.startsWith('2002:') &&
      !a.startsWith('3fff:')
    );
  }
  return false;
}
async function providerRequest(
  input: ProviderRequest,
): Promise<ProviderResponse> {
  const addresses = await lookup(input.url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new ApiError(400, 'API 地址解析到受限制的网络，无法连接');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      input.url,
      {
        method: 'POST',
        agent: false,
        signal: input.signal,
        // Pin the checked DNS result to this TLS connection; redirects are never followed.
        lookup: (_host, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
        headers: {
          Authorization: `Bearer ${input.key}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(input.body),
        },
      },
      (res) => resolve({ status: res.statusCode || 502, body: res }),
    );
    req.on('error', reject);
    req.end(input.body);
  });
}
export function createAiMiddleware(options: Options = {}) {
  const sessions = new Map<string, Session>();
  const now = options.now || Date.now;
  const allowedBases = (
    options.allowedBases || [
      'https://api.openai.com/v1',
      ...(process.env.AI_ALLOWED_BASE_URLS || '').split(',').filter(Boolean),
    ]
  ).map(normalizeBase);
  const origin = options.origin || process.env.APP_ORIGIN;
  if (origin) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error(
        'APP_ORIGIN 必须是 HTTPS 站点来源，只有 localhost 可使用 HTTP',
      );
  }
  const provider = options.provider || providerRequest;
  const clean = () => {
    for (const [id, s] of sessions)
      if (s.expiresAt <= now()) {
        for (const active of s.active) active.abort();
        sessions.delete(id);
      }
  };
  const cleanup = setInterval(clean, 60_000);
  cleanup.unref();
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const sessionId = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
  async function body(req: IncomingMessage) {
    if (!req.headers['content-type']?.startsWith('application/json'))
      throw new ApiError(415, '请求格式不正确');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY)
        throw new ApiError(413, '本次对话太长，请减少附带内容');
      chunks.push(Buffer.from(chunk));
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      return value;
    } catch {
      throw new ApiError(400, '请求内容不正确');
    }
  }
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/ai/')) {
      next();
      return;
    }
    let abort: AbortController | undefined;
    let activeSession: Session | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      clean();
      const host = req.headers.host || '';
      const requestOrigin =
        origin ||
        (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
          ? 'http://' + host
          : '');
      if (!requestOrigin)
        throw new ApiError(503, '管理员需要先设置本站的 HTTPS 访问地址');
      if (
        req.method !== 'GET' &&
        (req.headers.origin !== requestOrigin ||
          req.headers['x-memo-ai'] !== '1' ||
          req.headers['sec-fetch-site'] === 'cross-site')
      )
        throw new ApiError(403, '请从本站页面发起请求');
      const id = sessionId(req);
      const session = id ? sessions.get(id) : undefined;
      if (path === '/api/ai/session' && req.method === 'GET') {
        json(res, 200, {
          available: true,
          allowedBases,
          session: session
            ? {
                baseUrl: session.baseUrl,
                model: session.model,
                expiresAt: session.expiresAt,
              }
            : null,
        });
        return;
      }
      const cookie = (token: string, maxAge: number) =>
        `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/ai; Max-Age=${maxAge}${requestOrigin.startsWith('https:') ? '; Secure' : ''}`;
      if (path === '/api/ai/session' && req.method === 'DELETE') {
        if (session) {
          for (const active of session.active) active.abort();
        }
        if (id) sessions.delete(id);
        res.setHeader('Set-Cookie', cookie('', 0));
        json(res, 200, { disconnected: true });
        return;
      }
      if (path === '/api/ai/session' && req.method === 'POST') {
        const input = await body(req);
        const baseUrl = normalizeBase(input.baseUrl);
        if (!allowedBases.includes(baseUrl))
          throw new ApiError(
            400,
            '这个 API 地址尚未由本站启用，请选择列表中的地址或联系管理员添加',
          );
        if (
          typeof input.key !== 'string' ||
          !/^[\x21-\x7e]{8,500}$/.test(input.key)
        )
          throw new ApiError(400, 'Key 格式不正确，请检查是否多复制了空格');
        if (
          typeof input.model !== 'string' ||
          !/^[\w./:@-]{1,150}$/.test(input.model)
        )
          throw new ApiError(400, '请输入服务商提供的模型名称');
        if (sessions.size >= 500)
          throw new ApiError(503, '当前连接较多，请稍后再试');
        if (session) {
          for (const active of session.active) active.abort();
        }
        if (id) sessions.delete(id);
        const token = randomBytes(32).toString('hex');
        const expiresAt = now() + SESSION_MS;
        sessions.set(token, {
          key: input.key,
          baseUrl,
          model: input.model,
          expiresAt,
          requests: [],
          active: new Set(),
        });
        res.setHeader('Set-Cookie', cookie(token, SESSION_MS / 1000));
        json(res, 200, { session: { baseUrl, model: input.model, expiresAt } });
        return;
      }
      if (path !== '/api/ai/chat' || req.method !== 'POST')
        throw new ApiError(404, '未找到这个操作');
      if (!session)
        throw new ApiError(401, '连接已过期，请重新配置 Key；本机对话仍然保留');
      session.requests = session.requests.filter((t) => now() - t < 60_000);
      if (session.active.size || session.requests.length >= 10)
        throw new ApiError(429, '请等待上一条回复结束，或稍后再发送');
      const input = await body(req);
      if (
        !Array.isArray(input.messages) ||
        !input.messages.length ||
        input.messages.length > 401
      )
        throw new ApiError(400, '对话格式不正确');
      let chars = 0;
      const messages = input.messages.map(
        (m: { role: string; content: string }) => {
          if (
            !m ||
            !['system', 'user', 'assistant'].includes(m.role) ||
            typeof m.content !== 'string' ||
            !m.content.trim()
          )
            throw new ApiError(400, '对话消息不正确');
          chars += m.content.length;
          return { role: m.role, content: m.content };
        },
      );
      if (chars > 60_000)
        throw new ApiError(413, '本次上下文过长，请减少附带笔记');
      if (![512, 1024, 2048, 4096].includes(input.maxTokens))
        throw new ApiError(400, '请选择回复长度上限');
      // Recheck after the asynchronous body read to prevent concurrent request races.
      if (!id || sessions.get(id) !== session || session.expiresAt <= now())
        throw new ApiError(401, '连接已过期，请重新配置 Key');
      if (session.active.size || session.requests.length >= 10)
        throw new ApiError(429, '请等待上一条回复结束，或稍后再发送');
      abort = new AbortController();
      activeSession = session;
      session.active.add(abort);
      session.requests.push(now());
      const controller = abort;
      res.on('close', () => controller.abort());
      timeout = setTimeout(() => controller.abort(), 120_000);
      const isOpenAI = new URL(session.baseUrl).hostname === 'api.openai.com';
      const response = await provider({
        url: new URL(session.baseUrl + '/chat/completions'),
        key: session.key,
        signal: abort.signal,
        body: JSON.stringify({
          model: session.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(isOpenAI
            ? { max_completion_tokens: input.maxTokens, store: false }
            : { max_tokens: input.maxTokens }),
        }),
      });
      if (response.status !== 200) {
        controller.abort();
        const errors: Record<number, string> = {
          401: '服务商未接受这个 Key，请检查后重新连接',
          403: '此 Key 没有访问该模型的权限',
          404: '服务商未找到该模型或聊天接口，请检查模型名和 API 地址',
          429: '服务商额度不足或请求过于频繁，请检查余额和用量',
        };
        throw new ApiError(
          502,
          errors[response.status] ||
            '服务商暂时无法完成请求，请检查模型是否支持文字流式聊天',
        );
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream;charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      const emit = async (value: unknown) => {
        if (res.destroyed) throw new Error('Disconnected');
        if (!res.write(`data: ${JSON.stringify(value)}\n\n`))
          await once(res, 'drain', { signal: controller.signal });
      };
      let reason = '',
        completed = false,
        outputChars = 0;
      for await (const raw of sseData(response.body)) {
        if (raw === '[DONE]') {
          completed = true;
          break;
        }
        const event = JSON.parse(raw);
        if (event.error) throw new Error('Provider error');
        const choice = event.choices?.[0];
        const text = choice?.delta?.content || choice?.delta?.refusal;
        if (typeof text === 'string') {
          outputChars += text.length;
          if (outputChars > 64_000) throw new Error('Output limit');
          await emit({ type: 'text', text });
        }
        if (choice?.finish_reason) reason = choice.finish_reason;
        if (
          event.usage &&
          Number.isSafeInteger(event.usage.prompt_tokens) &&
          Number.isSafeInteger(event.usage.completion_tokens) &&
          event.usage.prompt_tokens >= 0 &&
          event.usage.completion_tokens >= 0
        )
          await emit({
            type: 'usage',
            usage: {
              input: event.usage.prompt_tokens,
              output: event.usage.completion_tokens,
            },
          });
      }
      if (!completed && !reason) throw new Error('Incomplete stream');
      await emit({ type: 'done', reason: reason || 'stop' });
      res.end();
    } catch (error) {
      // Never echo upstream response bodies, network errors, request payloads or keys.
      const message =
        error instanceof ApiError
          ? error.message
          : '连接中断或服务商暂时不可用，已收到的内容会保留';
      if (res.headersSent) {
        if (!res.destroyed)
          res.end(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      } else
        json(res, error instanceof ApiError ? error.status : 502, {
          error: message,
        });
    } finally {
      if (timeout) clearTimeout(timeout);
      abort?.abort();
      if (abort) activeSession?.active.delete(abort);
    }
  };
  return {
    handler,
    close() {
      clearInterval(cleanup);
      for (const s of sessions.values())
        for (const active of s.active) active.abort();
      sessions.clear();
    },
  };
}
