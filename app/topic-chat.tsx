'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  MessageCircle,
  Send,
  Square,
  Settings2,
  Download,
  Copy,
  NotebookPen,
  RotateCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { type Topic, teachingPrompt } from '@/lib/catalogue';
import { type Memo } from '@/lib/records';
import { chatStore, registerChatFlush } from '@/lib/chat-store';
import {
  chatContext,
  chatMarkdown,
  validateChat,
  MAX_CHAT_MESSAGES,
  type TopicChat,
  type ChatMessage,
} from '@/lib/topic-chat';
import { consumeAiStream } from '@/lib/ai-stream';
import { copyText, download } from '@/lib/client-api';
import { toast } from '@/lib/notifications';

type Connection = { baseUrl: string; model: string; expiresAt: number };
const headers = { 'Content-Type': 'application/json', 'X-Memo-AI': '1' };
async function connectionRequest(method = 'GET', body?: unknown) {
  const response = await fetch('/api/ai/session', {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      '当前是静态网站。内置聊天需要启用第二版服务端，仍可复制主题去学习',
    );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '连接暂时不可用');
  return data;
}

export default function TopicChatPanel({
  node,
  memo,
  onAppendNote,
  onActivity,
}: {
  node: Topic;
  memo: Memo;
  onAppendNote: (text: string) => boolean;
  onActivity: () => void;
}) {
  const formId = useId();
  const [chat, setChat] = useState<TopicChat | null>(null);
  const [text, setText] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [allowedBases, setAllowedBases] = useState<string[]>([]);
  const [settings, setSettings] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [includeNote, setIncludeNote] = useState(false);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [busy, setBusy] = useState<'chat' | 'note' | null>(null);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('正在读取本机对话…');
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteReady, setNoteReady] = useState(false);
  const [contextNotice, setContextNotice] = useState('');
  const current = useRef<TopicChat | null>(null);
  const revision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveFailure = useRef(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  const persist = useCallback(() => {
    if (!current.current || saveFailure.current || !pending.current)
      return saveQueue.current;
    if (timer.current) clearTimeout(timer.current);
    const snapshot = current.current;
    pending.current = true;
    saveQueue.current = saveQueue.current.then(async () => {
      if (saveFailure.current) return;
      try {
        const saved = await chatStore().write(snapshot, revision.current);
        revision.current = saved.revision;
        if (current.current === snapshot) {
          current.current = saved;
          pending.current = false;
          if (alive.current) {
            setChat(saved);
            setSaveStatus('对话已保存到本机');
          }
        }
      } catch (e) {
        saveFailure.current = true;
        abortRef.current?.abort();
        if (alive.current) {
          setSaveBlocked(true);
          setSaveStatus((e as Error).message);
        }
      }
    });
    return saveQueue.current;
  }, []);
  const update = (next: TopicChat) => {
    const valid = validateChat(next);
    current.current = valid;
    pending.current = true;
    if (alive.current) {
      setChat(valid);
      setSaveStatus('正在保存对话…');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), 450);
  };
  const patchMessage = (id: string, patch: Partial<ChatMessage>) => {
    if (current.current)
      update({
        ...current.current,
        messages: current.current.messages.map((m) =>
          m.id === id ? { ...m, ...patch } : m,
        ),
      });
  };
  const refreshConnection = useCallback(async () => {
    try {
      const data = await connectionRequest();
      if (!alive.current) return;
      setConnection(data.session);
      setAllowedBases(data.allowedBases || []);
      setConnectionError('');
      if (data.session) {
        setBaseUrl(data.session.baseUrl);
        setModel(data.session.model);
      }
    } catch (e) {
      if (alive.current) {
        setConnection(null);
        setConnectionError((e as Error).message);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void chatStore()
      .get(node.uid)
      .then((saved) => {
        if (!alive.current) return;
        current.current = saved;
        revision.current = saved.revision;
        setChat(saved);
        setSaveStatus(
          saved.messages.length ? '对话已恢复' : '对话自动保存在本机',
        );
      })
      .catch((e) => {
        if (alive.current) setError((e as Error).message);
      });
    void Promise.resolve().then(refreshConnection);
    const hide = () => {
      if (document.visibilityState === 'hidden') void persist();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (pending.current || abortRef.current) event.preventDefault();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('beforeunload', unload);
    const unregisterFlush = registerChatFlush(async () => {
      await persist();
      if (saveFailure.current)
        throw new Error('当前对话尚未保存，请先在主题内导出对话');
    });
    return () => {
      alive.current = false;
      abortRef.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      void persist();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('beforeunload', unload);
      unregisterFlush();
    };
  }, [node.uid, persist, refreshConnection]);
  const lastContent = chat?.messages.at(-1)?.content;
  useEffect(() => {
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [lastContent, busy]);
  const connect = async () => {
    setConnecting(true);
    setConnectionError('');
    const secret = key.trim();
    setKey('');
    try {
      const data = await connectionRequest('POST', {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        key: secret,
      });
      setConnection(data.session);
      setSettings(false);
      toast.success('已建立临时连接；Key 与模型会在首次发送时验证');
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    setConnecting(true);
    try {
      await connectionRequest('DELETE');
      setConnection(null);
      setKey('');
      toast.success('已断开连接并清除服务端临时 Key');
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };
  const systemPrompt = () => {
    const prompt = teachingPrompt(
      node,
      memo.title || node.title,
      memo.points.map((p) => p.title),
    );
    return (
      prompt.slice(0, 16_000) +
      '\n\n当前是应用内文字聊天，没有网页检索、图片生成、文件访问或代码执行工具。请用文字、Markdown 和代码示例教学，不能声称已检索或运行。' +
      (includeNote && memo.note
        ? '\n\n以下是我选择附带的个人笔记，作为学习背景参考：\n' +
          memo.note.slice(0, 8_000)
        : '')
    );
  };
  const run = async (mode: 'chat' | 'note', retry = false) => {
    if (abortRef.current || !current.current || saveFailure.current) return;
    if (!connection || connection.expiresAt <= Date.now()) {
      setSettings(true);
      return;
    }
    setError('');
    setContextNotice('');
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(mode);
    let assistantId: string | undefined;
    let output = '';
    let completed = false;
    try {
      let messages = current.current.messages;
      if (mode === 'chat') {
        if (retry) {
          const last = messages.at(-1);
          if (
            !(
              last?.role === 'user' ||
              (last?.role === 'assistant' && last.status !== 'complete')
            )
          )
            throw new Error('没有待重试的问题');
        } else {
          if (!text.trim()) return;
          if (text.trim().length > 8_000)
            throw new Error('一条消息最多 8,000 字，请分段发送');
          messages = [
            ...messages,
            {
              id: crypto.randomUUID(),
              role: 'user',
              content: text.trim(),
              createdAt: new Date().toISOString(),
              status: 'complete',
            },
          ];
        }
        if (messages.length + 1 > MAX_CHAT_MESSAGES)
          throw new Error('本主题对话已满，请先导出留存');
        assistantId = crypto.randomUUID();
        update({
          ...current.current,
          messages: [
            ...messages,
            {
              id: assistantId,
              role: 'assistant',
              content: '',
              status: 'interrupted',
              createdAt: new Date().toISOString(),
              model: connection.model,
            },
          ],
        });
        setText('');
        await persist();
        if (saveFailure.current)
          throw new Error('本机对话尚未保存，请先导出当前内容');
        onActivity();
      } else {
        setNoteDraft('');
        setNoteReady(false);
        messages = [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: 'user',
            status: 'complete',
            createdAt: new Date().toISOString(),
            content:
              '请把上面的学习讨论整理成一份简洁的 Markdown 笔记：核心解释、具体例子、我确实做过的练习、尚未弄懂的问题、相关主题及下一步。保留不确定性，不替我判断已掌握，不添加对话中没有的学习成果。只输出笔记正文。',
          },
        ];
      }
      const context = chatContext(messages, systemPrompt());
      setContextNotice(
        context.truncated
          ? '本次只携带最近的讨论；更早的完整对话仍保存在本机。'
          : includeNote && memo.note.length > 8_000
            ? '本次附带笔记的前 8,000 字。'
            : '',
      );
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ messages: context.messages, maxTokens }),
        signal: controller.signal,
      });
      await consumeAiStream(response, (event) => {
        if (event.type === 'text') {
          output += event.text;
          if (mode === 'chat' && assistantId)
            patchMessage(assistantId, { content: output });
          else if (alive.current) setNoteDraft(output);
        } else if (event.type === 'usage' && assistantId) {
          patchMessage(assistantId, { usage: event.usage });
        } else if (event.type === 'done') {
          completed = true;
          if (event.reason !== 'stop')
            setContextNotice(
              '本次回复达到长度上限或被服务商结束，可继续追问。',
            );
        }
      });
      if (!output.trim())
        throw new Error(
          '模型没有返回文字，可能用尽了推理或回复额度；可调整长度后重试',
        );
      if (assistantId) patchMessage(assistantId, { status: 'complete' });
      else if (alive.current) setNoteReady(true);
    } catch (e) {
      if (assistantId)
        patchMessage(assistantId, {
          status: controller.signal.aborted ? 'interrupted' : 'error',
        });
      if (alive.current)
        setError(
          controller.signal.aborted
            ? '已停止，收到的内容已保留。停止前产生的用量仍可能计费。'
            : (e as Error).message,
        );
    } finally {
      if (mode === 'chat') await persist();
      if (abortRef.current === controller) abortRef.current = null;
      if (alive.current) {
        setBusy(null);
        if (!completed && mode === 'note') setNoteReady(false);
      }
    }
  };
  const usage = chat?.messages
    .filter((m) => m.model === connection?.model)
    .reduce(
      (a, m) => ({
        input: a.input + (m.usage?.input || 0),
        output: a.output + (m.usage?.output || 0),
      }),
      { input: 0, output: 0 },
    );
  const cost =
    inputPrice !== '' && outputPrice !== '' && usage
      ? (usage.input * Number(inputPrice) +
          usage.output * Number(outputPrice)) /
        1_000_000
      : null;
  const canRetry =
    chat?.messages.at(-1)?.role === 'user' ||
    (chat?.messages.at(-1)?.role === 'assistant' &&
      chat.messages.at(-1)?.status !== 'complete');
  return (
    <section className="topic-chat" aria-label="主题内 AI 对话">
      <div className="chat-toolbar">
        <div>
          <strong>
            <MessageCircle size={18} /> 和 AI 一起学
          </strong>
          <span className="hint">
            {connection ? connection.model : '配置自己的 Key，即可在这里讨论'}
          </span>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setSettings(true);
            void refreshConnection();
          }}
        >
          <Settings2 />
          {connection ? '连接设置' : '连接 AI'}
        </Button>
      </div>
      {connectionError && !settings && (
        <p className="hint">{connectionError}</p>
      )}
      <div
        className="chat-history"
        role="log"
        aria-label="当前主题对话"
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!chat?.messages.length && (
          <div className="chat-empty">
            <MessageCircle size={26} />
            <p>从一个好奇的问题开始</p>
            <span>
              AI 会参考「{memo.title || node.title}
              」的知识地图，也可以跟着你的兴趣展开。
            </span>
            <Button
              variant="outline"
              onClick={() =>
                setText(
                  '用一个生活中的例子带我理解这个主题，再一起看看可以往哪里探索。',
                )
              }
            >
              帮我找个切入点
            </Button>
          </div>
        )}
        {chat?.messages.map((m) => (
          <article key={m.id} className={`chat-message chat-${m.role}`}>
            <div className="chat-message-meta">
              <span>
                {m.role === 'user' ? '我' : 'AI'}
                {m.status !== 'complete'
                  ? busy && m.id === chat.messages.at(-1)?.id
                    ? ' · 正在回答'
                    : ' · 未完成'
                  : ''}
              </span>
              {m.content && (
                <Button
                  variant="ghost"
                  aria-label="复制这条消息"
                  onClick={() =>
                    void copyText(m.content)
                      .then(() => toast.success('已复制'))
                      .catch((e) => toast.error(e.message))
                  }
                >
                  <Copy size={14} />
                </Button>
              )}
            </div>
            <div className="chat-message-text">{m.content || '正在思考…'}</div>
          </article>
        ))}
        <div ref={bottom} />
      </div>
      <output className="chat-storage-status">{saveStatus}</output>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {contextNotice && <p className="hint">{contextNotice}</p>}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void run('chat');
        }}
      >
        <Textarea
          aria-label="向 AI 提问"
          placeholder="哪里不明白，或突然想到了什么？"
          value={text}
          maxLength={8000}
          disabled={!chat || !!busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void run('chat');
            }
          }}
        />
        <div className="chat-composer-actions">
          <label className="check-label" htmlFor={formId + '-include-note'}>
            <Checkbox
              id={formId + '-include-note'}
              checked={includeNote}
              onCheckedChange={(value) => setIncludeNote(!!value)}
              disabled={!!busy}
            />
            附带我的笔记
          </label>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => abortRef.current?.abort()}
            >
              <Square />
              停止
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!chat || !text.trim() || saveBlocked}
            >
              <Send />
              {connection ? '发送' : '配置后开始'}
            </Button>
          )}
        </div>
      </form>
      <p className="hint">
        发送当前主题与本次讨论；只有勾选后才附带笔记。AI 回答请自行核实。
      </p>
      <div className="chat-bottom-actions">
        {canRetry && (
          <Button
            variant="outline"
            disabled={!!busy || saveBlocked}
            onClick={() => void run('chat', true)}
          >
            <RotateCw />
            重试回答
          </Button>
        )}
        <Button
          variant="outline"
          disabled={
            !!busy ||
            !chat?.messages.some((m) => m.role === 'assistant' && m.content)
          }
          onClick={() => void run('note')}
        >
          <NotebookPen />
          整理为笔记
        </Button>
        <Button
          variant="ghost"
          disabled={!chat?.messages.length}
          onClick={() => {
            if (current.current)
              download(
                `${node.code}-AI对话.md`,
                chatMarkdown(current.current, memo.title || node.title),
              );
          }}
        >
          <Download />
          导出对话
        </Button>
      </div>
      {!!usage && !!(usage.input + usage.output) && (
        <p className="hint">
          此模型已知用量：输入 {usage.input.toLocaleString()} / 输出{' '}
          {usage.output.toLocaleString()} tokens
          {cost !== null && Number.isFinite(cost)
            ? ` · 约 ${cost.toFixed(4)}（按填写的单价币种）`
            : ''}
          。不含未返回用量的中断请求和笔记整理，以服务商账单为准。
        </p>
      )}
      {(noteDraft || busy === 'note') && (
        <div className="chat-note-preview">
          <h3>笔记草稿 · 确认后追加</h3>
          <Textarea
            aria-label="AI 整理的笔记草稿"
            value={noteDraft}
            readOnly={busy === 'note'}
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <div className="action-row">
            <Button
              disabled={!noteReady || !!busy || !noteDraft.trim()}
              onClick={() => {
                if (onAppendNote(noteDraft)) {
                  setNoteDraft('');
                  setNoteReady(false);
                }
              }}
            >
              追加到本主题笔记
            </Button>
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                setNoteDraft('');
                setNoteReady(false);
              }}
            >
              放弃草稿
            </Button>
          </div>
          <p className="hint">
            只追加笔记，完成度仍由你决定。草稿确认前仅保留在当前页面。
          </p>
        </div>
      )}
      <Dialog
        open={settings}
        onOpenChange={(value) => {
          if (!connecting) {
            setSettings(value);
            if (!value) setKey('');
          }
        }}
      >
        <DialogContent className="ai-settings-dialog">
          <DialogTitle>连接你自己的 AI</DialogTitle>
          <DialogDescription>
            使用兼容 OpenAI 聊天接口的服务，费用由你的 API 账户承担。
          </DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
            className="ai-settings-form"
          >
            <label htmlFor={formId + '-base'}>
              API 地址
              <Input
                id={formId + '-base'}
                type="url"
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                list="ai-approved-endpoints"
                autoComplete="off"
              />
            </label>
            <datalist id="ai-approved-endpoints">
              {allowedBases.map((base) => (
                <option value={base} key={base}>
                  {base}
                </option>
              ))}
            </datalist>
            <p className="hint">
              本站已启用：{allowedBases.join('、') || '正在读取'}
            </p>
            <label htmlFor={formId + '-model'}>
              模型名称
              <Input
                id={formId + '-model'}
                required
                placeholder="填写服务商提供的模型 ID"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                autoComplete="off"
                maxLength={150}
              />
            </label>
            <label htmlFor={formId + '-key'}>
              API Key
              <Input
                id={formId + '-key'}
                required
                type="password"
                placeholder="粘贴你的 Key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={500}
              />
            </label>
            <p className="hint">
              Key 经本站服务端转发，仅在服务端内存保留 2
              小时，断开或服务重启即清除；不会写入浏览器存储和备份。请只在你信任的网站配置
              Key。
            </p>
            <label>
              每次回复额度上限
              <select
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              >
                <option value={512}>512 tokens · 简短</option>
                <option value={1024}>1,024 tokens</option>
                <option value={2048}>2,048 tokens · 默认</option>
                <option value={4096}>4,096 tokens · 较长</option>
              </select>
            </label>
            <details>
              <summary>费用估算（可选）</summary>
              <p className="hint">
                填服务商每百万 tokens
                的价格，输入与输出使用同一币种。仅估算当前主题聊天，服务商可能另计缓存或其他费用。
              </p>
              <div className="ai-price-fields">
                <label htmlFor={formId + '-input-price'}>
                  输入单价
                  <Input
                    id={formId + '-input-price'}
                    type="number"
                    min="0"
                    step="any"
                    value={inputPrice}
                    onChange={(e) => setInputPrice(e.target.value)}
                  />
                </label>
                <label htmlFor={formId + '-output-price'}>
                  输出单价
                  <Input
                    id={formId + '-output-price'}
                    type="number"
                    min="0"
                    step="any"
                    value={outputPrice}
                    onChange={(e) => setOutputPrice(e.target.value)}
                  />
                </label>
              </div>
            </details>
            {connectionError && (
              <p className="notice error" role="alert">
                {connectionError}
              </p>
            )}
            <div className="action-row">
              <Button type="submit" disabled={connecting || !!busy}>
                {connecting
                  ? '处理中…'
                  : connection
                    ? '更换连接'
                    : '建立临时连接'}
              </Button>
              {connection && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={connecting || !!busy}
                  onClick={() => void disconnect()}
                >
                  断开并清除 Key
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
