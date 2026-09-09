'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Copy,
  Save,
  Plus,
  FileUp,
  ListChecks,
  Download,
  Check,
  RotateCw,
  PencilLine,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/lib/notifications';
import { subtopicProgress } from '@/lib/recommendations';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  type Topic,
  pathOf,
  teachingPrompt,
  childrenOf,
} from '@/lib/catalogue';
import {
  contentOf,
  emptyMemo,
  extractHeadings,
  MAX_NOTE,
  MAX_POINTS,
  validateMemo,
  type Memo,
  type SavedMemo,
  type Summary,
} from '@/lib/records';
import { copyText, download } from '@/lib/client-api';
import { localApi as api } from '@/lib/local-store';
import { getDraft, saveDraft, removeDraft } from '@/lib/drafts';
import {
  appendChatImport,
  normalizeChatImport,
  publicSourceUrl,
  type ChatImport,
} from '@/lib/chat-import';

export default function MemoEditor({
  node,
  profile,
  onSaved,
  onOpenTopic,
  summaries,
}: {
  node: Topic;
  profile: string;
  onSaved: (m: SavedMemo) => void;
  onOpenTopic: (uid: string) => void;
  summaries: Record<string, Summary>;
}) {
  const subtopics = childrenOf(node);
  const childProgress = subtopicProgress(subtopics, summaries);
  const [doc, setDoc] = useState<Memo | null>(null);
  const [notice, setNotice] = useState('正在读取…');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<SavedMemo | null>(null);
  const [pointTitle, setPointTitle] = useState('');
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(
    new Set(),
  );
  const [importPreview, setImportPreview] = useState<
    (ChatImport & { fileName: string }) | null
  >(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const importSequence = useRef(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true),
    current = useRef<Memo | null>(null),
    revision = useRef(0),
    dirty = useRef(false),
    saving = useRef(false),
    blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftQueue = useRef<Promise<unknown>>(Promise.resolve());
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const status = (text: string) => {
    if (alive.current) setNotice(text);
  };
  const keepDraft = (record: Memo, base: number) => {
    draftQueue.current = draftQueue.current
      .catch(() => {})
      .then(() => saveDraft(profile, record, base));
    return draftQueue.current;
  };
  const flush = async () => {
    if (saving.current || !dirty.current || !current.current || blocked.current)
      return;
    if (timer.current) clearTimeout(timer.current);
    saving.current = true;
    if (alive.current) setBusy(true);
    const snapshot = contentOf(current.current);
    const expected = revision.current;
    try {
      validateMemo(snapshot);
      try {
        await keepDraft(snapshot, expected);
      } catch {
        status('草稿保存失败，正在尝试保存笔记…');
      }
      status('正在保存到本机…');
      const result = await api<{ record: SavedMemo }>('/api/memos', {
        method: 'POST',
        headers: { 'X-Memo-Profile': profile },
        body: JSON.stringify({ record: snapshot, expectedRevision: expected }),
      });
      revision.current = result.record.revision;
      savedCallback.current(result.record);
      if (JSON.stringify(current.current) === JSON.stringify(snapshot)) {
        dirty.current = false;
        draftQueue.current = draftQueue.current
          .catch(() => {})
          .then(() => removeDraft(profile, node.uid));
        await draftQueue.current;
        status('已保存到本机');
      } else {
        await keepDraft(current.current!, revision.current);
        status('正在保存新修改…');
      }
    } catch (error) {
      const e = error as Error & {
        status?: number;
        data?: { current?: SavedMemo };
      };
      if (e.status === 409 && e.data?.current) {
        blocked.current = true;
        if (alive.current) setConflict(e.data.current);
        status('发现另一处修改，本机内容已保留');
      } else {
        blocked.current = true;
        status(`${e.message} · 修改仍保留在当前页面，请重试或导出`);
      }
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
      if (dirty.current && !blocked.current)
        timer.current = setTimeout(() => void flush(), 500);
    }
  };
  const update = (next: Memo) => {
    current.current = next;
    dirty.current = true;
    setDoc(next);
    keepDraft(next, revision.current)
      .then(() => {
        if (dirty.current && !saving.current) status('本机草稿已保存');
      })
      .catch(() => status('本机草稿未保存，请保持页面打开或导出'));
    if (timer.current) clearTimeout(timer.current);
    if (!blocked.current) timer.current = setTimeout(() => void flush(), 350);
  };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    (async () => {
      let draft;
      try {
        draft = await getDraft(profile, node.uid);
      } catch {
        status('本机草稿暂时不可用');
      }
      try {
        const data = await api<{ record: SavedMemo; profile: string }>(
          '/api/memos?topic=' + node.uid,
        );
        if (data.profile !== profile)
          throw new Error('本机记录空间已改变，请刷新页面');
        if (cancelled) return;
        revision.current = data.record.revision;
        current.current = draft ? draft.record : contentOf(data.record);
        setDoc(current.current);
        setLoadFailed(false);
        if (draft) {
          dirty.current = true;
          if (
            JSON.stringify(draft.record) ===
            JSON.stringify(contentOf(data.record))
          ) {
            dirty.current = false;
            await removeDraft(profile, node.uid);
            status('已保存到本机');
          } else if (draft.baseRevision !== data.record.revision) {
            blocked.current = true;
            setConflict(data.record);
            status('有本机草稿，也有另一处修改');
          } else {
            status('已恢复本机草稿');
            blocked.current = false;
            timer.current = setTimeout(() => void flush(), 1000);
          }
        } else
          status(
            data.record.revision ? '已保存到本机' : '写下内容后自动保存到本机',
          );
      } catch {
        if (cancelled) return;
        if (draft) {
          current.current = draft.record;
          revision.current = draft.baseRevision;
          dirty.current = true;
          blocked.current = true;
          setDoc(draft.record);
          status('已恢复草稿，请点击保存重试');
        } else {
          setLoadFailed(true);
          status('暂时无法读取本机存储，请重试或检查浏览器设置');
        }
      }
    })();
    const online = () => {
      if (dirty.current && !conflict) {
        blocked.current = false;
        void flush();
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      cancelled = true;
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      void flush();
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
    };
    // This editor is keyed by profile + permanent topic ID; all asynchronous saves use that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.uid, profile, retry]);
  const copy = async (prompt: boolean) => {
    try {
      await copyText(
        prompt
          ? teachingPrompt(
              node,
              doc?.title || node.title,
              doc?.points.map((p) => p.title),
            )
          : `${node.code} ${doc?.title || node.title}\n${pathOf(node)
              .map((n) => n.title)
              .join(' → ')}`,
      );
      toast.success('已复制，可以粘贴给教学 AI');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const importText = async (file?: File) => {
    if (!file) return;
    const sequence = ++importSequence.current;
    try {
      if (file.size > 5_000_000)
        throw new Error(
          '请选择 5 MB 以内的 TXT、Markdown、JSON 或 HTML 聊天文件',
        );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      const parsed = await normalizeChatImport(text, file.name);
      if (!alive.current || sequence !== importSequence.current) return;
      setImportPreview({ ...parsed, fileName: file.name });
      if (parsed.sourceUrl) setSourceUrl((value) => value || parsed.sourceUrl);
      toast.info('已生成导入预览；确认后才会写入当前主题');
    } catch (e) {
      if (alive.current && sequence === importSequence.current)
        toast.error((e as Error).message);
    }
  };
  const confirmImport = () => {
    const latest = current.current;
    if (!latest || !importPreview) return;
    try {
      const url = publicSourceUrl(sourceUrl);
      const note = appendChatImport(
        latest.note,
        importPreview.text,
        importPreview.fileName,
        url,
      );
      update(validateMemo({ ...latest, note }));
      setImportPreview(null);
      setSourceUrl('');
      toast.success('对话已追加；完成度与知识点保持不变');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const saveSourceLink = () => {
    const latest = current.current;
    if (!latest || !sourceUrl.trim()) return;
    try {
      const url = publicSourceUrl(sourceUrl);
      const note = `${latest.note}${latest.note ? '\n\n' : ''}原对话链接：${url}`;
      update(validateMemo({ ...latest, note }));
      setSourceUrl('');
      toast.success('链接已追加到笔记，可回到原对话查看素材');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const addPoint = () => {
    if (!doc || !pointTitle.trim()) return;
    if (doc.points.length >= MAX_POINTS) {
      toast.error('每个主题最多 200 个知识点');
      return;
    }
    update({
      ...doc,
      points: [
        ...doc.points,
        { id: crypto.randomUUID(), title: pointTitle.trim(), done: false },
      ],
    });
    setPointTitle('');
  };
  const mergeConflict = () => {
    if (!doc || !conflict) return;
    const points = [...doc.points];
    for (const p of conflict.points) {
      const local = points.find((q) => q.id === p.id);
      if (!local) points.push(p);
      else if (JSON.stringify(local) !== JSON.stringify(p))
        points.push({
          ...p,
          id: crypto.randomUUID(),
          title: `${p.title.slice(0, 290)}（另一处）`,
        });
    }
    const note =
      doc.note === conflict.note
        ? doc.note
        : `${doc.note}\n\n---\n## 另一处保存的版本\n标题：${conflict.title || node.title}\n完成度：${conflict.progress}%\n\n${conflict.note}`;
    const merged = { ...doc, points, note };
    try {
      validateMemo(merged);
    } catch {
      toast.error('合并后内容过大，请先导出两个版本并手动整理');
      return;
    }
    revision.current = conflict.revision;
    setConflict(null);
    blocked.current = false;
    update(merged);
    void flush();
  };
  return (
    <>
      <p className="breadcrumb">
        {pathOf(node)
          .map((n) => n.title)
          .join(' / ')}
      </p>
      <span className="eyebrow">{node.code}</span>
      <h2>{doc?.title || node.title}</h2>
      <div className="action-row copy-actions">
        <Button onClick={() => void copy(true)}>
          <Copy />
          复制给教学 AI
        </Button>
        <Button variant="ghost" onClick={() => void copy(false)}>
          只复制主题
        </Button>
      </div>
      {loadFailed ? (
        <div className="notice error">
          {notice}
          <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
            <RotateCw />
            重新读取
          </Button>
        </div>
      ) : !doc ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : (
        <>
          <div className="save-bar">
            <span role="status" className={blocked.current ? 'warning' : ''}>
              {notice}
            </span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (conflict) {
                  toast.info('请先处理两个版本');
                  return;
                }
                blocked.current = false;
                void flush();
              }}
            >
              <Save />
              {busy ? '保存中' : '保存'}
            </Button>
          </div>
          {conflict && (
            <div className="conflict-box">
              <h3>另一处也修改了这个主题</h3>
              <p>
                你的内容仍在下方。合并会保留两份不同的笔记与知识点，完成度使用你当前的数值。
              </p>
              <p className="muted">
                另一处：{conflict.title || node.title} · {conflict.progress}%
              </p>
              <pre>
                {conflict.note.slice(0, 600) || '（没有笔记）'}
                {conflict.note.length > 600 ? '…' : ''}
              </pre>
              <div className="action-row">
                <Button onClick={mergeConflict}>保留两份并保存</Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    download(
                      '另一处的笔记.json',
                      JSON.stringify(contentOf(conflict), null, 2),
                      'application/json',
                    )
                  }
                >
                  导出另一版本
                </Button>
              </div>
            </div>
          )}
          <Tabs defaultValue="overview">
            <TabsList className="editor-tabs">
              <TabsTrigger value="overview">学习进度</TabsTrigger>
              <TabsTrigger value="points">
                知识点{doc.points.length ? ` · ${doc.points.length}` : ''}
              </TabsTrigger>
              <TabsTrigger value="notes">
                笔记{doc.note ? ' · 有内容' : ''}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="editor-tab-panel">
              <section className="completion-card">
                <div className="completion-heading">
                  <label className="check-label">
                    <Checkbox
                      aria-label="这个主题已学过"
                      checked={doc.progress === 100}
                      onCheckedChange={(checked) =>
                        update({ ...doc, progress: checked ? 100 : 0 })
                      }
                    />
                    <span>这个主题已学过</span>
                  </label>
                  <strong>{doc.progress}%</strong>
                </div>
                <Slider
                  aria-label="主题完成度"
                  min={0}
                  max={100}
                  step={5}
                  value={[doc.progress]}
                  onValueChange={(value) =>
                    update({
                      ...doc,
                      progress: Array.isArray(value) ? value[0] : value,
                    })
                  }
                />
                <p>按自己的学习情况记录；不等于已经完全掌握。</p>
              </section>
              {subtopics.length > 0 && (
                <section className="subtopic-outline">
                  <div className="section-heading">
                    <h3>分开学习这些小主题</h3>
                    <span>{subtopics.length} 项</span>
                  </div>
                  <p className="hint">
                    下级平均按各小主题的记录计算；上方进度由你自己填写。
                  </p>
                  <div className="subtopic-summary">
                    <Progress
                      value={childProgress.average}
                      aria-label="下级主题平均完成度"
                    />
                    <span>
                      下级平均 {childProgress.average}% · 已完成{' '}
                      {childProgress.completed}/{childProgress.total}
                    </span>
                  </div>
                  <div className="subtopic-links">
                    {subtopics.map((child) => (
                      <Button
                        key={child.uid}
                        variant="outline"
                        onClick={() => onOpenTopic(child.uid)}
                      >
                        <span className="subtopic-info">
                          <small>{child.code}</small>
                          <strong>
                            {summaries[child.uid]?.title || child.title}
                          </strong>
                          <Progress
                            value={summaries[child.uid]?.progress || 0}
                            aria-label={`${child.title}完成度`}
                          />
                        </span>
                        <span className="subtopic-percent">
                          {summaries[child.uid]?.progress || 0}%
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              )}
              <Collapsible className="title-customization">
                <CollapsibleTrigger>
                  <PencilLine size={15} /> 自定义主题名称
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <label className="field-label" htmlFor="topic-title">
                    我的主题名称
                  </label>
                  <Input
                    id="topic-title"
                    maxLength={300}
                    placeholder={node.title}
                    value={doc.title}
                    onChange={(e) => update({ ...doc, title: e.target.value })}
                  />
                </CollapsibleContent>
              </Collapsible>
            </TabsContent>
            <TabsContent value="points" className="editor-tab-panel">
              <section className="note-section">
                <div className="section-heading">
                  <h3>知识点清单</h3>
                  <span>
                    {doc.points.filter((p) => p.done).length} /{' '}
                    {doc.points.length}
                  </span>
                </div>
                {doc.points.length > 0 && (
                  <Progress
                    aria-label="知识点勾选比例"
                    value={Math.round(
                      (doc.points.filter((p) => p.done).length /
                        doc.points.length) *
                        100,
                    )}
                  />
                )}
                <p className="hint">
                  一个主题可以继续拆细。知识点勾选与主题完成度分别记录。
                </p>
                <div className="points">
                  {doc.points.map((p) => (
                    <div className="point" key={p.id}>
                      <Checkbox
                        aria-label={`完成知识点：${p.title}`}
                        checked={p.done}
                        onCheckedChange={(done) =>
                          update({
                            ...doc,
                            points: doc.points.map((q) =>
                              q.id === p.id ? { ...q, done: !!done } : q,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label="知识点标题"
                        value={p.title}
                        maxLength={300}
                        onChange={(e) => {
                          if (e.target.value.trim())
                            update({
                              ...doc,
                              points: doc.points.map((q) =>
                                q.id === p.id
                                  ? { ...q, title: e.target.value }
                                  : q,
                              ),
                            });
                        }}
                        className={p.done ? 'point-done' : ''}
                      />
                    </div>
                  ))}
                </div>
                <div className="add-point">
                  <Input
                    aria-label="新增知识点"
                    maxLength={300}
                    placeholder="例如：右手指法与节奏练习"
                    value={pointTitle}
                    onChange={(e) => setPointTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        addPoint();
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    aria-label="添加知识点"
                    onClick={addPoint}
                  >
                    <Plus />
                  </Button>
                </div>
              </section>
            </TabsContent>
            <TabsContent value="notes" className="editor-tab-panel">
              <section className="note-section">
                <div className="section-heading">
                  <h3>笔记与聊天原文</h3>
                  <span>{doc.note.length.toLocaleString()} 字</span>
                </div>
                <div className="note-toolbar">
                  <label className="file-button">
                    <FileUp size={17} />
                    导入聊天文件
                    <input
                      type="file"
                      accept=".txt,.md,.markdown,.json,.html,.htm,.xhtml"
                      onChange={(e) => {
                        void importText(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const list = extractHeadings(
                        doc.note,
                        doc.points.map((p) => p.title),
                      );
                      setSuggestions(list);
                      setSelectedSuggestions(new Set());
                    }}
                  >
                    <ListChecks />
                    挑选标题作为知识点
                  </Button>
                </div>
                {suggestions !== null && (
                  <div className="suggestions">
                    <strong>识别到 {suggestions.length} 个新标题</strong>
                    <p className="hint">
                      标题只是候选，勾选你想记录的概念；加入后仍是未完成状态。
                    </p>
                    {suggestions.length > 0 && (
                      <ul>
                        {suggestions.map((t) => (
                          <li key={t}>
                            <Checkbox
                              checked={selectedSuggestions.has(t)}
                              onCheckedChange={(checked) => {
                                const next = new Set(selectedSuggestions);
                                if (checked) next.add(t);
                                else next.delete(t);
                                setSelectedSuggestions(next);
                              }}
                              aria-label={`选择知识点：${t}`}
                            />
                            <span>{t}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="action-row">
                      <Button
                        disabled={!selectedSuggestions.size}
                        onClick={() => {
                          const latest = current.current;
                          if (!latest) return;
                          const existing = new Set(
                            latest.points.map((p) => p.title.trim()),
                          );
                          const titles = suggestions.filter(
                            (title) =>
                              selectedSuggestions.has(title) &&
                              !existing.has(title.trim()),
                          );
                          if (
                            latest.points.length + titles.length >
                            MAX_POINTS
                          ) {
                            toast.error('超过 200 个知识点，请减少本次选择');
                            return;
                          }
                          update(
                            validateMemo({
                              ...latest,
                              points: [
                                ...latest.points,
                                ...titles.map((title) => ({
                                  id: crypto.randomUUID(),
                                  title,
                                  done: false,
                                })),
                              ],
                            }),
                          );
                          setSuggestions(null);
                          setSelectedSuggestions(new Set());
                        }}
                      >
                        加入 {selectedSuggestions.size} 个知识点
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setSuggestions(null)}
                      >
                        收起
                      </Button>
                    </div>
                  </div>
                )}
                {importPreview && (
                  <section className="import-preview" aria-label="导入预览">
                    <div className="section-heading">
                      <h3>导入预览</h3>
                      <span>
                        {importPreview.format}
                        {importPreview.messageCount
                          ? ` · ${importPreview.messageCount} 条消息`
                          : ''}
                      </span>
                    </div>
                    <p className="hint">
                      {importPreview.fileName} ·{' '}
                      {importPreview.text.length.toLocaleString()} 字
                    </p>
                    <p className="hint">
                      先检查内容，再决定是否追加。它不会自动改变完成度，也不会自动把标题变成知识点。
                    </p>
                    {importPreview.warnings.map((warning) => (
                      <p className="hint" key={warning}>
                        · {warning}
                      </p>
                    ))}
                    <Textarea
                      value={importPreview.text.slice(0, 50_000)}
                      readOnly
                      className="import-preview-text"
                      aria-label="对话导入预览"
                    />
                    {importPreview.text.length > 50_000 && (
                      <p className="hint">
                        预览截取前 50,000 字，确认后仍会追加完整正文。
                      </p>
                    )}
                    <div className="action-row">
                      <Button onClick={confirmImport}>
                        确认追加到当前主题
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          importSequence.current++;
                          setImportPreview(null);
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </section>
                )}
                <div className="source-url-field">
                  <Input
                    type="url"
                    aria-label="原对话链接"
                    placeholder="可选：粘贴原对话链接，方便回看图片和附件"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                  />
                  {!importPreview && (
                    <Button
                      variant="outline"
                      disabled={!sourceUrl.trim()}
                      onClick={saveSourceLink}
                    >
                      保存链接
                    </Button>
                  )}
                  <p className="hint">
                    {importPreview
                      ? '确认追加时一并保存链接。'
                      : '可单独保存原对话链接。'}
                    链接不会自动导入正文或下载图片、附件。
                  </p>
                </div>
                <Textarea
                  aria-label="学习笔记和 AI 聊天原文"
                  className="note-editor"
                  placeholder="把 AI 的完整聊天粘贴在这里，也可以直接写笔记。支持保留 Markdown、代码与换行。"
                  value={doc.note}
                  maxLength={MAX_NOTE}
                  onChange={(e) => update({ ...doc, note: e.target.value })}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault();
                      if (!conflict) {
                        blocked.current = false;
                        void flush();
                      }
                    }
                  }}
                />
                <div className="note-footer">
                  <span>原文按文本保存，不执行其中的代码。</span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      download(
                        `${node.code}-学习笔记.md`,
                        `# ${doc.title || node.title}\n\n${pathOf(node)
                          .map((n) => n.title)
                          .join(
                            ' → ',
                          )}\n\n完成度：${doc.progress}%\n\n${doc.points.map((p) => `- [${p.done ? 'x' : ' '}] ${p.title}`).join('\n')}\n\n${doc.note}`,
                      )
                    }
                  >
                    <Download />
                    导出本主题
                  </Button>
                </div>
              </section>
            </TabsContent>
          </Tabs>
        </>
      )}
    </>
  );
}
