import type { DefaultTreeAdapterTypes } from 'parse5';

export type ChatImport = {
  text: string;
  format: string;
  messageCount: number | null;
  warnings: string[];
  sourceUrl: string;
};
type ObjectValue = Record<string, unknown>;
type HtmlNode = DefaultTreeAdapterTypes.Node;
const object = (v: unknown): ObjectValue | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as ObjectValue)
    : null;
const string = (v: unknown) => (typeof v === 'string' ? v : '');
const unreadable = () =>
  new Error(
    '未能识别完整的公开对话正文，请改用复制的 TXT / Markdown，或导出单次对话。尚未写入笔记。',
  );
const mediaNotice =
  '只保存文字、图片说明和链接，不保存原图、附件或可运行 Demo；需要时请保留原对话及文件。';

/** References are text only. No URL is requested by the importer. */
export function publicSourceUrl(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error('原对话链接需要以 https:// 或 http:// 开头');
  }
}
function reference(label: string, value: string): string {
  const title = label.replace(/[\r\n[\]]/g, ' ').trim() || '引用';
  try {
    const url = publicSourceUrl(value);
    if (url)
      return `[${title}](<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
  } catch {
    /* Local and unavailable references stay plain text. */
  }
  const local = value.trim();
  if (local && !/^(?:javascript|data|vbscript|blob):/i.test(local)) {
    return `[${title}：引用 ${local.replace(/[\r\n[\]]/g, ' ').slice(0, 500)}（需原文件或原对话）]`;
  }
  return `[${title}：原文件或原对话中查看]`;
}

type Reader = {
  get: (value: unknown, key: string) => unknown;
  list: (value: unknown) => unknown[];
  entries: (value: unknown) => [string, unknown][];
};
const jsonReader: Reader = {
  get: (v, k) => object(v)?.[k],
  list: (v) => (Array.isArray(v) ? v : []),
  entries: (v) => Object.entries(object(v) || {}),
};

/** Decode only known public message fields, never arbitrary serialized strings. */
function poolReader(pool: unknown[]): Reader {
  const ref = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0
      ? pool[v]
      : undefined;
  const entries = (v: unknown): [string, unknown][] =>
    Object.entries(object(v) || {}).flatMap(([key, value]) => {
      if (!/^_\d+$/.test(key)) return [];
      const name = ref(Number(key.slice(1)));
      return typeof name === 'string' ? [[name, ref(value)]] : [];
    });
  return {
    get: (v, key) => entries(v).find(([name]) => name === key)?.[1],
    list: (v) => (Array.isArray(v) ? v.map(ref) : []),
    entries,
  };
}
function publicMessage(message: unknown, reader: Reader): string | null {
  const get = reader.get;
  const role = get(get(message, 'author'), 'role') || get(message, 'role');
  const channel = get(message, 'channel');
  const recipient = get(message, 'recipient');
  if (role !== 'user' && role !== 'assistant') return null;
  if (
    role === 'assistant' &&
    ((channel && channel !== 'final') || (recipient && recipient !== 'all'))
  )
    return null;
  const content = get(message, 'content');
  let body: string;
  if (typeof content === 'string') body = content;
  else {
    const parts = Array.isArray(content)
      ? reader.list(content)
      : reader.list(get(content, 'parts'));
    body = parts
      .map((part) => {
        if (typeof part === 'string') return part;
        const type = string(get(part, 'content_type') || get(part, 'type'));
        if (type === 'text' || type === 'input_text' || type === 'output_text')
          return string(get(part, 'text'));
        if (/image|audio|video|file|asset/.test(type)) {
          const label =
            string(get(part, 'alt') || get(part, 'name')) || '图片或附件';
          return `\n${reference(label, string(get(part, 'url')))}\n`;
        }
        throw unreadable();
      })
      .join('\n');
    if (!parts.length && typeof get(content, 'text') === 'string') {
      body = string(get(content, 'text'));
    }
    if (!body && /image|audio|video/.test(string(get(content, 'content_type'))))
      body = '[图片、音频或视频：请在原对话中查看]';
    if (
      !body &&
      !parts.length &&
      content &&
      typeof get(content, 'text') !== 'string'
    )
      throw unreadable();
  }
  if (!body?.trim()) return null;
  // Bold speaker labels are deliberately not knowledge-point headings.
  return `**${role === 'user' ? '我' : '教学 AI'}**\n\n${body}`;
}
function mappedMessages(data: unknown, reader: Reader): string[] {
  const mapping = new Map(reader.entries(reader.get(data, 'mapping')));
  let cursor = reader.get(data, 'current_node');
  if (!mapping.size || typeof cursor !== 'string') throw unreadable();
  const seen = new Set<string>();
  const result: string[] = [];
  while (cursor !== null && cursor !== undefined) {
    if (
      typeof cursor !== 'string' ||
      seen.has(cursor) ||
      seen.size >= 10000 ||
      !mapping.has(cursor)
    )
      throw unreadable();
    seen.add(cursor);
    const node = mapping.get(cursor);
    const message = reader.get(node, 'message');
    if (message) {
      const text = publicMessage(message, reader);
      if (text) result.push(text);
    }
    cursor = reader.get(node, 'parent');
  }
  if (!result.length) throw unreadable();
  return result.reverse();
}
function sharedMessages(html: string): string[] | null {
  if (!html.includes('streamController.enqueue')) return null;
  for (const match of html.matchAll(
    /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g,
  )) {
    try {
      const pool: unknown = JSON.parse(JSON.parse(match[1]));
      if (!Array.isArray(pool)) continue;
      const reader = poolReader(pool);
      const loader = reader.get(pool[0], 'loaderData');
      const route = reader.get(loader, 'routes/share.$shareId.($action)');
      const data = reader.get(reader.get(route, 'serverResponse'), 'data');
      if (data) return mappedMessages(data, reader);
    } catch {
      /* Do not import page chrome or hidden metadata as conversation. */
    }
  }
  throw unreadable();
}

const children = (node: HtmlNode): HtmlNode[] =>
  'childNodes' in node ? node.childNodes : [];
const attr = (node: HtmlNode, name: string) =>
  'attrs' in node ? node.attrs.find((a) => a.name === name)?.value || '' : '';
function allNodes(root: HtmlNode): HtmlNode[] {
  const nodes: HtmlNode[] = [],
    stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    nodes.push(node);
    if (nodes.length > 100000) throw new Error('HTML 结构过大，请改用聊天文本');
    stack.push(...children(node).slice().reverse());
  }
  return nodes;
}
const skipped = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'form',
  'button',
]);
function htmlText(node: HtmlNode, depth = 0, literal = false): string {
  if (depth > 150) throw new Error('HTML 嵌套过深，请改用聊天文本');
  if ('value' in node)
    return literal ? node.value : node.value.replace(/\s+/g, ' ');
  const tag = 'tagName' in node ? node.tagName : '';
  if (
    skipped.has(tag) ||
    ('attrs' in node && node.attrs.some((a) => a.name === 'hidden')) ||
    attr(node, 'aria-hidden') === 'true'
  )
    return '';
  const content = () =>
    children(node)
      .map((n) => htmlText(n, depth + 1, literal || tag === 'pre'))
      .join('');
  if (tag === 'br') return '\n';
  if (tag === 'img')
    return `\n${reference(`图片：${attr(node, 'alt') || '无说明'}`, attr(node, 'src'))}\n`;
  if (
    ['svg', 'canvas', 'iframe', 'video', 'audio', 'object', 'embed'].includes(
      tag,
    )
  )
    return `\n${reference('图示或交互内容', attr(node, 'src'))}\n`;
  const text = content();
  if (tag === 'a') return reference(text || '链接', attr(node, 'href'));
  if (tag === 'pre') {
    const fence = '`'.repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    return `\n\n${fence}\n${text}\n${fence}\n\n`;
  }
  if (/^h[1-6]$/.test(tag))
    return `\n\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
  if (tag === 'li') return `\n- ${text.trim()}\n`;
  if (tag === 'td' || tag === 'th') return `${text}\t`;
  if (
    [
      'p',
      'div',
      'article',
      'section',
      'blockquote',
      'ul',
      'ol',
      'tr',
      'hr',
    ].includes(tag)
  )
    return `\n\n${text.trim()}\n\n`;
  return text;
}

/** Static parsing only: no scripts, external requests, account writes, or AI calls. */
export async function normalizeChatImport(
  text: string,
  fileName: string,
): Promise<ChatImport> {
  if (text.length > 5_000_000 || text.includes('\0'))
    throw new Error('请选择 5 MB 以内的 UTF-8 聊天文本或网页文件');
  if (!/\.(txt|md|markdown|json|html?|xhtml)$/i.test(fileName))
    throw new Error('支持 TXT、Markdown、单次对话 JSON 和 HTML');
  const result: ChatImport = {
    text,
    format: '原始文本',
    messageCount: null,
    warnings: [mediaNotice],
    sourceUrl: '',
  };
  let messages: string[] | null = null;
  if (/\.json$/i.test(fileName)) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON 格式不完整，请使用完整文件或另存为 TXT');
    }
    if (Array.isArray(data) && data.length === 1 && object(data[0])?.mapping)
      data = data[0];
    if (object(data)?.mapping) messages = mappedMessages(data, jsonReader);
    else if (Array.isArray(object(data)?.messages)) {
      messages = (object(data)!.messages as unknown[])
        .map((m) => publicMessage(m, jsonReader))
        .filter((m): m is string => m !== null);
      if (!messages.length) throw unreadable();
    } else {
      result.warnings.push(
        '未识别为单次对话 JSON，以下保留完整原始文本；不会替你选择或合并多个对话。',
      );
    }
  } else if (/\.(html?|xhtml)$/i.test(fileName)) {
    messages = sharedMessages(text);
    const { parse } = await import('parse5');
    const tree = parse(text),
      nodes = allNodes(tree);
    const canonical = nodes.find(
      (n) =>
        'tagName' in n &&
        n.tagName === 'link' &&
        attr(n, 'rel') === 'canonical',
    );
    if (canonical) {
      try {
        result.sourceUrl = publicSourceUrl(attr(canonical, 'href'));
      } catch {
        /* Optional hint only. */
      }
    }
    if (!messages) {
      const tagged = nodes.filter((n) =>
        ['user', 'assistant'].includes(attr(n, 'data-message-author-role')),
      );
      if (tagged.length)
        messages = tagged.map(
          (n) =>
            `**${attr(n, 'data-message-author-role') === 'user' ? '我' : '教学 AI'}**\n\n${htmlText(n).trim()}`,
        );
      else {
        const body =
          nodes.find((n) => 'tagName' in n && n.tagName === 'main') ||
          nodes.find((n) => 'tagName' in n && n.tagName === 'body');
        result.text = body ? htmlText(body).trim() : '';
        if (!result.text) throw unreadable();
        result.warnings.push(
          '普通 HTML 按正文顺序转为文本；表格、排版及部分公式可能变化，请检查预览。',
        );
      }
    }
    result.format = 'HTML 正文';
  }
  if (messages) {
    result.text = messages.join('\n\n---\n\n');
    result.messageCount = messages.length;
    result.format = '对话正文';
    result.warnings.push(
      '按当前对话分支保留用户与 AI 正文；其他分支和工具内部消息不在本次归档中。',
    );
  }
  if (!result.text.trim()) throw unreadable();
  if (/image_group|sandbox:\/|asset_pointer|image/.test(result.text))
    result.warnings.push(
      '包含图片组标记或会话内文件路径，原图与 Demo 需回到原对话查看；这些标记不是已保存的文件。',
    );
  return result;
}

/** Append to the latest note; importing never implies learning or mutates points. */
export function appendChatImport(
  note: string,
  text: string,
  fileName: string,
  sourceUrl = '',
): string {
  const url = publicSourceUrl(sourceUrl);
  const name = fileName.replace(/[\r\n]/g, ' ');
  return `${note}${note ? '\n\n---\n\n' : ''}**对话归档：${name}**\n\n> 仅归档，不代表已学或掌握。${mediaNotice}\n\n${url ? `${reference('原对话', url)}\n\n` : ''}${text}`;
}
