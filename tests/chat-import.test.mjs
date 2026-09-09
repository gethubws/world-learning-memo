import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChatImport,
  appendChatImport,
  publicSourceUrl,
} from '../lib/chat-import.ts';
import {
  contentOf,
  emptyMemo,
  validateMemo,
  extractHeadings,
} from '../lib/records.ts';

test('plain chat preserves every character, code block and line break', async () => {
  const text = '  提问\r\n\r\n```html\n<img src="x">\n```\n最后  \n';
  const result = await normalizeChatImport(text, '学习.md');
  assert.equal(result.text, text);
  assert.equal(result.messageCount, null);
});

test('HTML keeps message order, headings, literal code and image/file references without scripts', async () => {
  const html = `<html><head><title>页面标题</title><link rel="canonical" href="https://example.com/chat"></head>
    <body><nav>导航不属于对话</nav>
    <article data-message-author-role="user"><p>怎么画 &lt;树&gt;？</p></article>
    <article data-message-author-role="assistant"><h2>贴图与位置</h2><p>前文</p>
    <img alt="树的纹理" src="https://example.com/tree.png" onerror="bad()">
    <p>后文</p><pre><code>if (x &lt; 3) {\n\n  draw("树");\n}</code></pre>
    <a href="sandbox:/mnt/data/demo.zip">实验文件</a><img alt="局部图" src="assets/a.png">
    <script>隐藏脚本 secret()</script><a href="javascript:bad()">不要执行</a>
    <canvas>图像绘制上下文</canvas></article></body></html>`;
  const r = await normalizeChatImport(html, '课程.html');
  assert.equal(r.messageCount, 2);
  assert.equal(r.sourceUrl, 'https://example.com/chat');
  for (const text of [
    '**我**',
    '**教学 AI**',
    '## 贴图与位置',
    '<树>',
    '树的纹理',
    'https://example.com/tree.png',
    'sandbox:/mnt/data/demo.zip',
    'assets/a.png',
  ])
    assert.ok(r.text.includes(text), text);
  assert.ok(r.text.includes('if (x < 3) {\n\n  draw("树");\n}'));
  assert.ok(r.text.indexOf('前文') < r.text.indexOf('树的纹理'));
  assert.ok(r.text.indexOf('树的纹理') < r.text.indexOf('后文'));
  for (const text of [
    'secret()',
    'onerror',
    'javascript:',
    '页面标题',
    '导航不属于对话',
  ])
    assert.ok(!r.text.includes(text), text);
  assert.ok(r.warnings.some((w) => w.includes('不保存原图')));
});

const message = (role, text, channel = null) => ({
  author: { role },
  channel,
  content: { content_type: 'text', parts: [text] },
});
function branchedConversation() {
  return {
    current_node: 'last',
    mapping: {
      root: { parent: null, message: null },
      q: { parent: 'root', message: message('user', '我的问题') },
      analysis: {
        parent: 'q',
        message: message('assistant', '隐藏分析不能导入', 'analysis'),
      },
      last: {
        parent: 'analysis',
        message: message('assistant', '公开的解答', 'final'),
      },
      sibling: { parent: 'q', message: message('assistant', '另一个分支') },
      tool: { parent: 'last', message: message('tool', '工具元数据') },
    },
  };
}
test('a single-chat JSON follows the active branch and omits nonpublic messages', async () => {
  const original = branchedConversation();
  const r = await normalizeChatImport(JSON.stringify(original), '课程.json');
  assert.equal(r.messageCount, 2);
  assert.ok(r.text.indexOf('我的问题') < r.text.indexOf('公开的解答'));
  for (const text of ['隐藏分析', '另一个分支', '工具元数据'])
    assert.ok(!r.text.includes(text));
  assert.equal(original.mapping.last.parent, 'analysis');
});

// Reference-pool fixture mirrors the supported share-page envelope, with no user's chat data.
function sharedHtml(data) {
  const pool = [];
  const store = (value) => {
    const index = pool.length;
    pool.push(null);
    if (Array.isArray(value)) pool[index] = value.map(store);
    else if (value && typeof value === 'object') {
      const record = {};
      for (const [key, child] of Object.entries(value))
        record[`_${store(key)}`] = store(child);
      pool[index] = record;
    } else pool[index] = value;
    return index;
  };
  store({
    loaderData: {
      'routes/share.$shareId.($action)': { serverResponse: { data } },
    },
    other: '内部元数据不要导入',
  });
  return `<html><body>页面导航<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(pool))})</script></body></html>`;
}
test('serialized HTML decodes only public fields on the active message chain', async () => {
  const result = await normalizeChatImport(
    sharedHtml(branchedConversation()),
    'share.html',
  );
  assert.equal(result.messageCount, 2);
  for (const text of ['内部元数据', '隐藏分析', '另一个分支', '页面导航'])
    assert.ok(!result.text.includes(text));
  assert.ok(result.text.includes('公开的解答'));
});
test('malformed serialized data, broken branches and cycles fail before returning an archive', async () => {
  await assert.rejects(
    normalizeChatImport(
      '<body>导航<script>streamController.enqueue("[]")</script></body>',
      'share.html',
    ),
  );
  for (const parent of ['last', 'missing']) {
    const data = branchedConversation();
    data.mapping.q.parent = parent;
    await assert.rejects(
      normalizeChatImport(JSON.stringify(data), 'chat.json'),
    );
    await assert.rejects(normalizeChatImport(sharedHtml(data), 'chat.html'));
  }
  await assert.rejects(normalizeChatImport('{"unfinished":', 'chat.json'));
  await assert.rejects(normalizeChatImport('\0', 'chat.txt'));
});
test('generic JSON is preserved with a warning, rather than mistaken for a transcript', async () => {
  const text = JSON.stringify([branchedConversation(), branchedConversation()]);
  const result = await normalizeChatImport(text, 'many.json');
  assert.equal(result.text, text);
  assert.ok(result.warnings.some((w) => w.includes('未识别为单次对话')));
});
test('multimedia produces honest placeholders and preserves surrounding text', async () => {
  const text = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: {
          parts: [
            '看这张图',
            {
              content_type: 'image_asset_pointer',
              asset_pointer: 'private_id',
            },
            '图片后面的解释',
          ],
        },
      },
    ],
  });
  const result = await normalizeChatImport(text, 'image.json');
  assert.ok(result.text.includes('图片后面的解释'));
  assert.ok(result.text.includes('原文件或原对话中查看'));
  assert.ok(!result.text.includes('private_id'));
});
test('appending uses the current note without changing completion, IDs or points, and respects storage limits', () => {
  const m = {
    ...contentOf(emptyMemo('11111111-1111-4111-8111-111111111111')),
    note: '预览期间的新笔记',
    progress: 65,
    points: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: '旧知识点',
        done: true,
      },
    ],
  };
  const snapshot = structuredClone(m);
  const result = validateMemo({
    ...m,
    note: appendChatImport(
      m.note,
      '## 试验\n观察结果',
      '试教.md',
      'https://example.com/chat',
    ),
  });
  assert.equal(result.progress, 65);
  assert.deepEqual(result.points, m.points);
  assert.deepEqual(m, snapshot);
  assert.ok(result.note.startsWith(m.note));
  assert.ok(result.note.includes('仅归档，不代表已学'));
  assert.deepEqual(extractHeadings(result.note, []), ['试验']);
  assert.throws(() =>
    validateMemo({
      ...m,
      note: appendChatImport(m.note, '中'.repeat(200000), 'too-large.md'),
    }),
  );
  assert.throws(() => publicSourceUrl('javascript:alert(1)'));
  assert.throws(() => publicSourceUrl('https://user:password@example.com'));
});
