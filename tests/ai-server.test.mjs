import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  createAiMiddleware,
  normalizeBase,
  publicAddress,
} from '../server/ai.ts';
import { consumeAiStream } from '../lib/ai-stream.ts';
const key = 'test-placeholder-key-not-a-real-secret';
const body = {
  messages: [{ role: 'user', content: '解释琴弦振动' }],
  maxTokens: 1024,
};
async function server(t, options = {}) {
  const calls = [];
  const ai = createAiMiddleware({
    provider: async (input) => {
      calls.push(input);
      return {
        status: 200,
        body: (async function* () {
          const data =
            [
              { choices: [{ delta: { content: '琴弦振动产生声音。' } }] },
              {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 20, completion_tokens: 30 },
              },
            ]
              .map((d) => `data: ${JSON.stringify(d)}\n\n`)
              .join('') + 'data: [DONE]\n\n';
          for (const byte of new TextEncoder().encode(data))
            yield new Uint8Array([byte]);
        })(),
      };
    },
    ...options,
  });
  const http = createServer(
    (req, res) =>
      void ai.handler(req, res, () => {
        res.writeHead(404);
        res.end();
      }),
  );
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    ai.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const request = (path, method = 'GET', data, cookie, extra = {}) =>
    fetch(origin + '/api/ai/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Memo-AI': '1',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const connect = async () => {
    const response = await request('session', 'POST', {
      baseUrl: 'https://api.openai.com/v1',
      model: 'test-model',
      key,
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { request, connect, calls };
}
test('key stays server-side; authenticated streaming returns only text and usage', async (t) => {
  const app = await server(t);
  const cookie = await app.connect();
  assert.ok(!cookie.includes(key));
  const status = await app.request('session', 'GET', undefined, cookie);
  const info = await status.text();
  assert.ok(!info.includes(key));
  assert.match(info, /test-model/);
  const response = await app.request('chat', 'POST', body, cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  const events = [];
  await consumeAiStream(response, (e) => events.push(e));
  assert.equal(
    events.find((e) => e.type === 'text').text,
    '琴弦振动产生声音。',
  );
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, {
    input: 20,
    output: 30,
  });
  assert.equal(app.calls[0].key, key);
  const sent = JSON.parse(app.calls[0].body);
  assert.equal(sent.max_completion_tokens, 1024);
  assert.equal(sent.store, false);
  assert.equal('max_tokens' in sent, false);
  assert.ok(!JSON.stringify(events).includes(key));
});
test('same-origin checks and session cookies are required; disconnect revokes access', async (t) => {
  const app = await server(t);
  assert.equal((await app.request('chat', 'POST', body)).status, 401);
  assert.equal(
    (
      await app.request('session', 'POST', { key }, undefined, {
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  const cookie = await app.connect();
  assert.equal(
    (await app.request('session', 'DELETE', undefined, cookie)).status,
    200,
  );
  assert.equal((await app.request('chat', 'POST', body, cookie)).status, 401);
  assert.equal(app.calls.length, 0);
});
test('sessions expire and a restarted server cannot recover credentials', async (t) => {
  let clock = 1000;
  const first = await server(t, { now: () => clock });
  const cookie = await first.connect();
  clock += 2 * 60 * 60 * 1000 + 1;
  assert.equal((await first.request('chat', 'POST', body, cookie)).status, 401);
  const second = await server(t);
  assert.equal(
    (await second.request('chat', 'POST', body, cookie)).status,
    401,
  );
});
test('unapproved and local endpoints are refused before any provider request', async (t) => {
  const app = await server(t);
  for (const baseUrl of [
    'http://localhost/v1',
    'https://127.0.0.1/v1',
    'https://api.openai.com/v1?secret=1',
    'https://unapproved.example/v1',
  ]) {
    const response = await app.request('session', 'POST', {
      baseUrl,
      model: 'model',
      key,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(app.calls.length, 0);
  assert.equal(
    normalizeBase('https://api.openai.com/v1/'),
    'https://api.openai.com/v1',
  );
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700::1111'), true);
});
test('provider errors never echo keys or private upstream diagnostics', async (t) => {
  const app = await server(t, {
    provider: async () => {
      throw new Error(key + ' private error');
    },
  });
  const response = await app.request('chat', 'POST', body, await app.connect());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes(key));
  assert.ok(!text.includes('private error'));
});
test('reply budgets and context limits are checked before billing', async (t) => {
  const app = await server(t),
    cookie = await app.connect();
  assert.equal(
    (await app.request('chat', 'POST', { ...body, maxTokens: 900000 }, cookie))
      .status,
    400,
  );
  assert.equal(
    (
      await app.request(
        'chat',
        'POST',
        { ...body, messages: [{ role: 'user', content: 'a'.repeat(60001) }] },
        cookie,
      )
    ).status,
    413,
  );
  assert.equal(app.calls.length, 0);
});
test('explicitly approved compatible services use their configured path and token parameter', async (t) => {
  let sent;
  const app = await server(t, {
    allowedBases: ['https://compatible.example/v1'],
    provider: async (request) => {
      sent = request;
      return {
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('data: [DONE]\n\n');
        })(),
      };
    },
  });
  const connection = await app.request('session', 'POST', {
    baseUrl: 'https://compatible.example/v1',
    model: 'my-model',
    key,
  });
  const cookie = connection.headers.get('set-cookie').split(';')[0];
  await (await app.request('chat', 'POST', body, cookie)).text();
  assert.equal(sent.url.href, 'https://compatible.example/v1/chat/completions');
  assert.equal(JSON.parse(sent.body).max_tokens, 1024);
});
test('HTTP public deployments are refused; public origin produces Secure HttpOnly cookies', async (t) => {
  assert.throws(
    () => createAiMiddleware({ origin: 'http://public.example' }),
    /HTTPS/,
  );
  const app = await server(t, { origin: 'https://memo.example' });
  const response = await app.request(
    'session',
    'POST',
    { baseUrl: 'https://api.openai.com/v1', model: 'model', key },
    undefined,
    { Origin: 'https://memo.example' },
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});
test('one session cannot generate twice at once and disconnect aborts its provider stream', async (t) => {
  let signal;
  const app = await server(t, {
    provider: async (input) => {
      signal = input.signal;
      return {
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"保留下来的部分"}}]}\n\n',
          );
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('aborted');
        })(),
      };
    },
  });
  const cookie = await app.connect();
  const response = await app.request('chat', 'POST', body, cookie);
  const text = response.text();
  assert.equal((await app.request('chat', 'POST', body, cookie)).status, 429);
  await app.request('session', 'DELETE', undefined, cookie);
  assert.ok(signal.aborted);
  assert.match(await text, /保留下来的部分/);
});
test('a closed client aborts the upstream request instead of generating in the background', async (t) => {
  let signal;
  let aborted;
  const cancelled = new Promise((resolve) => {
    aborted = resolve;
  });
  const app = await server(t, {
    provider: async (input) => {
      signal = input.signal;
      return {
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"start"}}]}\n\n',
          );
          await new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted();
                resolve();
              },
              { once: true },
            ),
          );
          throw new Error('aborted');
        })(),
      };
    },
  });
  const cookie = await app.connect();
  const response = await app.request('chat', 'POST', body, cookie);
  await response.body.cancel();
  await cancelled;
  assert.ok(signal.aborted);
});
test('upstream redirects are not followed and error bodies cannot reach the browser', async (t) => {
  const app = await server(t, {
    provider: async () => ({
      status: 302,
      body: {
        [Symbol.asyncIterator]() {
          throw new Error('must not consume redirect content');
        },
      },
    }),
  });
  const response = await app.request('chat', 'POST', body, await app.connect());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(key));
});
