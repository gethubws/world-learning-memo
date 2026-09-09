'use client';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  Search,
  ChevronRight,
  ArrowLeft,
  NotebookPen,
  Download,
  Upload,
  Settings2,
  Check,
  Smartphone,
  Sparkles,
  Home,
  Compass,
  RotateCw,
  ChevronLeft,
  X,
  Copy,
} from 'lucide-react';
import {
  nodes,
  roots,
  nodeMap,
  pathOf,
  inScope,
  catalogueVersion,
  childrenOf,
  teachingPrompt,
  type Topic,
} from '@/lib/catalogue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/lib/notifications';
import { download, copyText } from '@/lib/client-api';
import { localApi as api } from '@/lib/local-store';
import {
  contentOf,
  validateBackup,
  validateMemo,
  type Summary,
  type Memo,
  type SavedMemo,
} from '@/lib/records';
import { allDrafts, saveDraft, type Draft } from '@/lib/drafts';
import { registerMemoTools } from '@/lib/webmcp';
import { chatStore, flushChatSaves } from '@/lib/chat-store';
import { validateChatBackup, type TopicChat } from '@/lib/topic-chat';
const MemoEditor = lazy(() => import('./memo-editor'));
import {
  recommendTopics,
  randomTopic,
  type Recommendation,
} from '@/lib/recommendations';

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination';
import {
  levelEntries,
  catalogueSections,
  sectionOf,
  paginate,
  categoryProgress,
  type CatalogueSection,
} from '@/lib/catalogue-navigation';
import { domainPresentation, featuredDomains } from '@/lib/domain-presentation';

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type ImportPlan = {
  records: Memo[];
  chats: TopicChat[];
  drafts: { record: Memo; baseRevision: number }[];
  unknown: number;
};
type View = 'home' | 'catalogue' | 'learning';
export default function Workspace() {
  const [view, setView] = useState<View>('home');
  const [scope, setScope] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selected, setSelected] = useState<string | null>(null);
  const [section, setSection] = useState<CatalogueSection>('all');
  const [filter, setFilter] = useState('learning');
  const [page, setPage] = useState(1);
  const [randomSuggestion, setRandomSuggestion] =
    useState<Recommendation | null>(null);
  const drawHistory = useRef<string[]>([]);
  const [mobile, setMobile] = useState(false);
  const [profile, setProfile] = useState('');
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const scrollPane = useRef<HTMLElement>(null);
  const editorPane = useRef<HTMLElement>(null);
  const topic = selected ? nodeMap.get(selected) : null;
  const current = scope ? nodeMap.get(scope) : null;
  const refresh = useCallback(async () => {
    setLoadState('loading');
    try {
      const d = await api<{ profile: string; summaries: Summary[] }>(
        '/api/memos',
      );
      setProfile(d.profile);
      setSummaries(Object.fromEntries(d.summaries.map((m) => [m.uid, m])));
      setLoadState('ready');
      try {
        setDrafts(await allDrafts(d.profile));
      } catch {
        toast.warning('草稿存储不可用，请确认笔记显示“已保存到本机”后离开');
      }
    } catch (e) {
      setError((e as Error).message);
      setLoadState('error');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const media = matchMedia('(max-width:760px)');
    setMobile(media.matches);
    const size = () => setMobile(media.matches);
    media.addEventListener('change', size);
    const installer = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', installer);
    if ('serviceWorker' in navigator)
      navigator.serviceWorker
        .register('/sw.js')
        .then(async () => {
          const registration = await navigator.serviceWorker.ready;
          const warm = () =>
            registration.active?.postMessage({
              type: 'CACHE_APP',
              urls: performance
                .getEntriesByType('resource')
                .map((entry) => entry.name),
            });
          if (document.readyState === 'complete') warm();
          else window.addEventListener('load', warm, { once: true });
        })
        .catch(() => {});
    const unregister = registerMemoTools();
    return () => {
      media.removeEventListener('change', size);
      window.removeEventListener('beforeinstallprompt', installer);
      unregister?.();
    };
  }, [refresh]);
  const onSaved = useCallback((m: SavedMemo) => {
    setSummaries((prev) => ({
      ...prev,
      [m.uid]: {
        uid: m.uid,
        title: m.title,
        progress: m.progress,
        revision: m.revision,
        updatedAt: m.updatedAt,
        hasNote: !!m.note,
      },
    }));
  }, []);

  useEffect(() => {
    setPage(1);
    scrollPane.current?.scrollTo({ top: 0 });
  }, [scope, section, filter, view, query]);
  useEffect(() => {
    editorPane.current?.scrollTo({ top: 0 });
  }, [selected]);
  const stats = Object.values(summaries).filter(
    (s) => nodeMap.get(s.uid)?.trackable,
  );
  const learned = stats.filter((s) => s.progress === 100).length;
  const learning = stats.filter((s) => s.progress < 100).length;
  const recommendations = useMemo(
    () => recommendTopics(nodes, summaries),
    [summaries],
  );
  const suggestion =
    randomSuggestion && summaries[randomSuggestion.topic.uid]?.progress !== 100
      ? randomSuggestion
      : recommendations[0];
  const drawAnother = () => {
    const next = randomTopic(
      nodes,
      summaries,
      suggestion?.topic.uid,
      drawHistory.current,
    );
    if (!next) {
      toast.info('暂无其他未完成的小主题');
      return;
    }
    drawHistory.current = [...drawHistory.current, next.topic.uid].slice(-20);
    setRandomSuggestion(next);
  };
  const featured = useMemo(
    () => featuredDomains.map((code) => roots.find((n) => n.code === code)!),
    [],
  );
  const rollups = useMemo(
    () => categoryProgress(nodes, summaries),
    [summaries],
  );
  const searchIndex = useMemo(
    () =>
      new Map(
        nodes.map((n) => [
          n.uid,
          `${n.code} ${pathOf(n)
            .map((p) => p.title)
            .join(' ')}`.toLowerCase(),
        ]),
      ),
    [],
  );
  const entries = useMemo(() => {
    if (view === 'home') return [];
    if (view === 'catalogue' && !deferredQuery.trim())
      return levelEntries(nodes, scope, section);
    const terms = deferredQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const found = nodes.filter((n) => {
      if (!n.trackable) return false;
      const saved = summaries[n.uid];
      if (view === 'learning') {
        if (!saved) return false;
        if (filter === 'learning' && saved.progress === 100) return false;
        if (filter === 'learned' && saved.progress !== 100) return false;
        if (filter === 'notes' && !saved.hasNote) return false;
      } else if (!inScope(n, scope)) return false;
      const haystack = `${searchIndex.get(n.uid)} ${(saved?.title || '').toLowerCase()}`;
      return terms.every((term) => haystack.includes(term));
    });
    return view === 'learning'
      ? found.sort((a, b) =>
          summaries[b.uid].updatedAt.localeCompare(summaries[a.uid].updatedAt),
        )
      : found;
  }, [view, deferredQuery, scope, section, filter, summaries, searchIndex]);
  const paged = paginate(entries, page);
  const navigate = (next: View) => {
    setView(next);
    setSelected(null);
    setQuery('');
    if (next !== 'catalogue') setScope(null);
  };
  const enterCategory = (uid: string | null) => {
    setView('catalogue');
    setScope(uid);
    setQuery('');
    setSelected(null);
    setPage(1);
  };
  const openEntry = (entry: Topic) => {
    if (entry.trackable) setSelected(entry.uid);
    else enterCategory(entry.uid);
  };
  const changePage = (next: number) => {
    setPage(next);
    scrollPane.current?.scrollTo({ top: 0 });
  };
  const copyTopic = async (entry: Topic) => {
    try {
      await copyText(
        teachingPrompt(entry, summaries[entry.uid]?.title || entry.title),
      );
      toast.success('已复制，粘贴给教学 AI 就可以开始');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openSettings = async () => {
    setSettings(true);
    if (navigator.storage?.persisted)
      setPersistent(await navigator.storage.persisted().catch(() => false));
    if (profile)
      try {
        setDrafts(await allDrafts(profile));
      } catch {
        /* Already surfaced by persistence status. */
      }
  };
  const exportAll = async () => {
    setBusy(true);
    try {
      const records: Memo[] = [];
      let cursor: string | null = '';
      do {
        const page: { records: SavedMemo[]; nextCursor: string | null } =
          await api<{ records: SavedMemo[]; nextCursor: string | null }>(
            '/api/memos?export=1&after=' + encodeURIComponent(cursor),
          );
        records.push(...page.records.map(contentOf));
        cursor = page.nextCursor;
      } while (cursor);
      const local = await allDrafts(profile);
      await flushChatSaves();
      const chats = await chatStore().all();
      download(
        `世界知识-学习备份-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(
          {
            format: 'world-learning-memo',
            schemaVersion: 2,
            catalogueVersion,
            exportedAt: new Date().toISOString(),
            records,
            chats,
            drafts: local.map((d) => ({
              record: d.record,
              baseRevision: d.baseRevision,
            })),
          },
          null,
          2,
        ),
        'application/json',
      );
      toast.success(
        `已导出 ${records.length} 条记录、${chats.length} 份对话和 ${local.length} 份草稿`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const inspectBackup = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 50_000_000) throw new Error('备份超过 50 MB，请分批处理');
      const data = JSON.parse(await file.text());
      const records = validateBackup(data);
      const chats = validateChatBackup(data.chats);
      const raw = data.drafts || [];
      if (!Array.isArray(raw) || raw.length > 10000)
        throw new Error('草稿列表格式不正确');
      const ds = raw.map((d: { record: unknown; baseRevision: number }) => {
        if (!Number.isSafeInteger(d.baseRevision) || d.baseRevision < 0)
          throw new Error('草稿版本不正确');
        return { record: validateMemo(d.record), baseRevision: d.baseRevision };
      });
      if (new Set(ds.map((d) => d.record.uid)).size !== ds.length)
        throw new Error('备份有重复草稿');
      const known = (r: Memo) => !!nodeMap.get(r.uid)?.trackable;
      setImportPlan({
        records: records.filter(known),
        chats: chats.filter((chat) => !!nodeMap.get(chat.uid)?.trackable),
        drafts: ds.filter((d) => known(d.record)),
        unknown:
          records.filter((r) => !known(r)).length +
          ds.filter((d) => !known(d.record)).length +
          chats.filter((chat) => !nodeMap.get(chat.uid)?.trackable).length,
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const importAll = async () => {
    if (!importPlan || !profile) return;
    setBusy(true);
    let added = 0,
      skipped = 0,
      localAdded = 0,
      chatsAdded = 0;
    try {
      for (const record of importPlan.records) {
        try {
          const d = await api<{ record: SavedMemo }>('/api/memos', {
            method: 'POST',
            headers: { 'X-Memo-Profile': profile },
            body: JSON.stringify({ record, expectedRevision: 0 }),
          });
          onSaved(d.record);
          added++;
        } catch (e) {
          if ((e as { status?: number }).status === 409) skipped++;
          else throw e;
        }
      }
      const local = await allDrafts(profile);
      const ids = new Set(local.map((d) => d.record.uid));
      for (const d of importPlan.drafts) {
        if (ids.has(d.record.uid)) {
          skipped++;
          continue;
        }
        await saveDraft(profile, d.record, 0);
        ids.add(d.record.uid);
        localAdded++;
      }
      const existingChats = new Set((await chatStore().all()).map((chat) => chat.uid));
      for (const chat of importPlan.chats) {
        if (existingChats.has(chat.uid)) { skipped++; continue; }
        await chatStore().write(chat, 0);
        chatsAdded++;
      }
      setImportPlan(null);
      await refresh();
      toast.success(
        `已导入 ${added} 条记录、${chatsAdded} 份对话、${localAdded} 份草稿；跳过 ${skipped} 条已有内容`,
      );
    } catch (e) {
      toast.error(
        `已导入 ${added} 条记录，其余未完成：${(e as Error).message}。可重新导入，已有记录会保留。`,
      );
    } finally {
      setBusy(false);
    }
  };
  const editor =
    topic && profile ? (
      <Suspense
        fallback={
          <p className="notice" role="status">
            正在打开主题…
          </p>
        }
      >
        <MemoEditor
          key={profile + topic.uid}
          node={topic}
          profile={profile}
          onSaved={onSaved}
          summaries={summaries}
          onOpenTopic={(uid) => {
            const next = nodeMap.get(uid);
            if (next) openEntry(next);
          }}
        />
      </Suspense>
    ) : topic ? (
      <div className="empty-editor">
        <h2>{topic.title}</h2>
        <p>可以先复制目录学习；本机存储准备好后即可记录。</p>
        <div className="action-row copy-actions">
          <Button onClick={() => void copyTopic(topic)}>
            <Copy />
            复制给教学 AI
          </Button>
          <Button variant="ghost" onClick={() => void refresh()}>
            重试本机存储
          </Button>
        </div>
      </div>
    ) : null;
  const search = (home = false) => (
    <form
      className="searchbox"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (home && query.trim()) {
          setView('catalogue');
          setScope(null);
          setPage(1);
        }
      }}
    >
      <Search size={19} aria-hidden="true" />
      <Input
        aria-label={
          home
            ? '搜索知识主题'
            : view === 'learning'
              ? '搜索我的学习记录'
              : current
                ? `搜索${current.title}下的主题`
                : '搜索全部学习主题'
        }
        placeholder={
          view === 'learning' ? '搜索我的记录…' : '想学什么？搜索主题或技能'
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        enterKeyHint="search"
      />
      {query && (
        <Button
          type="button"
          variant="ghost"
          aria-label="清空搜索"
          onClick={() => setQuery('')}
        >
          <X size={16} />
        </Button>
      )}
      {home && (
        <Button type="submit" variant="ghost" aria-label="搜索主题">
          <ChevronRight size={18} />
        </Button>
      )}
    </form>
  );
  const connection = loadState !== 'ready' && (
    <div
      className={`connection-notice ${loadState === 'loading' ? 'connecting' : ''}`}
      role="status"
    >
      <span>{loadState === 'loading' ? '正在读取本机记录…' : error}</span>
      {loadState === 'error' ? (
        <Button variant="ghost" onClick={() => void refresh()}>
          重试
        </Button>
      ) : null}
    </div>
  );
  const domainCard = (n: Topic, compact = false) => {
    const { name, description, Icon } = domainPresentation(n.code);
    const saved = rollups[n.uid];
    return (
      <button
        key={n.uid}
        className={`domain-card ${compact ? 'compact-domain' : ''}`}
        data-family={sectionOf(n.code)}
        onClick={() => enterCategory(n.uid)}
        aria-label={`浏览${n.title}`}
      >
        <span className="domain-icon">
          <Icon size={23} strokeWidth={1.7} />
        </span>
        <span className="domain-copy">
          <strong>{n.code.startsWith('K') ? name : n.title}</strong>
          {!compact && (
            <small>
              {n.code.startsWith('K') ? description : '交叉索引入口'}
            </small>
          )}
        </span>
        {!compact && (
          <span className="domain-meta">
            {saved?.started
              ? `${saved.completed} 个小主题已学过`
              : `${childrenOf(n).length} 个分类`}
            <ChevronRight size={15} />
          </span>
        )}
      </button>
    );
  };
  const entryList = (
    <>
      {view === 'catalogue' && !scope && !query.trim() ? (
        <div className="domain-grid">
          {paged.items.map((n) => domainCard(n))}
        </div>
      ) : (
        <div className="topic-list">
          {paged.items.map((n) => {
            const saved = summaries[n.uid];
            const group = !n.trackable;
            const aggregate = rollups[n.uid];
            const progress = group
              ? aggregate?.average || 0
              : saved?.progress || 0;
            const { Icon } = domainPresentation(n.code);
            return (
              <button
                key={n.uid}
                className={`topic-row ${group ? 'group-row' : ''} ${selected === n.uid ? 'active' : ''}`}
                onClick={() => openEntry(n)}
              >
                {group ? (
                  <span className="group-icon" data-family={sectionOf(n.code)}>
                    <Icon size={19} />
                  </span>
                ) : (
                  <span
                    className={`topic-dot ${progress === 100 ? 'completed' : ''}`}
                  >
                    {progress === 100 && <Check size={12} />}
                  </span>
                )}
                <span className="topic-text">
                  <strong>{saved?.title || n.title}</strong>
                  {group ? (
                    <small>
                      {childrenOf(n).length} 个下级条目
                      {aggregate?.started
                        ? ` · ${aggregate.completed} 个小主题已学过`
                        : ''}
                    </small>
                  ) : (
                    <small>
                      {saved?.hasNote ? '有笔记 · ' : ''}
                      {n.code}
                      {childrenOf(n).length
                        ? ` · 可细分 ${childrenOf(n).length} 项`
                        : ''}
                    </small>
                  )}
                  {(!group || !!aggregate?.started) && (
                    <Progress
                      className="topic-progress"
                      value={progress}
                      aria-label={`${n.title}${group ? '末级主题平均' : ''}完成度`}
                    />
                  )}
                  {query.trim() && (
                    <em>
                      {pathOf(n)
                        .slice(0, -1)
                        .map((p) => p.title)
                        .join(' / ')}
                    </em>
                  )}
                </span>
                {!group && <span className="row-percent">{progress}%</span>}
                <ChevronRight size={16} />
              </button>
            );
          })}
        </div>
      )}
      {!entries.length && (
        <div className="list-empty">
          <BookOpen size={28} />
          <h3>
            {query.trim()
              ? '暂时没有找到'
              : view === 'learning'
                ? '从感兴趣的主题开始'
                : '这个索引还在整理中'}
          </h3>
          <p>
            {query.trim()
              ? '换一个关键词，或扩大搜索范围。'
              : view === 'learning'
                ? '记录进度或写下笔记后，它就会出现在这里。'
                : '你可以先到其他领域探索已展开的目录。'}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              enterCategory(null);
              setSection('all');
            }}
          >
            浏览领域
          </Button>
        </div>
      )}
      {paged.pages > 1 && (
        <Pagination className="directory-pagination" aria-label="目录分页">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="ghost"
                disabled={paged.page === 1}
                onClick={() => changePage(paged.page - 1)}
              >
                <ChevronLeft size={17} />
                上一页
              </Button>
            </PaginationItem>
            <PaginationItem>
              <span className="page-number" aria-live="polite">
                {paged.page} / {paged.pages}
              </span>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                disabled={paged.page === paged.pages}
                onClick={() => changePage(paged.page + 1)}
              >
                下一页
                <ChevronRight size={17} />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </>
  );
  return (
    <div className="memo-app">
      <Toaster />
      <header className="app-header">
        <button
          className="brand"
          onClick={() => navigate('home')}
          aria-label="世界知识首页"
        >
          <span className="brand-icon">
            <BookOpen size={23} />
          </span>
          <span>
            <strong>世界知识</strong>
            <small>我的学习备忘录</small>
          </span>
        </button>
        <div className="header-actions">
          <span className="header-hint">
            <Smartphone size={15} />
            免登录 · 本机保存
          </span>
          <Button
            variant="ghost"
            onClick={() => void openSettings()}
            aria-label="设置、备份与安装"
          >
            <Settings2 size={20} />
          </Button>
        </div>
      </header>
      <Tabs
        value={view}
        onValueChange={(value) => navigate(value as View)}
        className="app-tabs"
      >
        <TabsList className="primary-navigation" aria-label="主导航">
          <TabsTrigger value="home">
            <Home size={20} />
            <span>首页</span>
          </TabsTrigger>
          <TabsTrigger value="catalogue">
            <Compass size={20} />
            <span>目录</span>
          </TabsTrigger>
          <TabsTrigger value="learning">
            <NotebookPen size={20} />
            <span>我的学习</span>
          </TabsTrigger>
        </TabsList>
        <main className={`workspace ${topic && !mobile ? 'with-editor' : ''}`}>
          <section className="catalogue-pane" ref={scrollPane}>
            <TabsContent value="home" className="home-panel">
              <div className="home-heading">
                <h1>今天，想了解什么？</h1>
                <span>
                  {loadState === 'ready' && learning
                    ? `${learning} 个主题进行中`
                    : '随手学一点'}
                </span>
              </div>
              {search(true)}
              {connection}
              {suggestion ? (
                <section
                  className="focus-card"
                  data-family={sectionOf(suggestion.topic.code)}
                >
                  <div className="focus-top">
                    <span>
                      <Sparkles size={16} />
                      {randomSuggestion
                        ? '随便看看'
                        : summaries[suggestion.topic.uid]
                          ? '接着上次学'
                          : '给好奇心一个方向'}
                    </span>
                    {suggestion && (
                      <Button variant="ghost" onClick={drawAnother}>
                        <RotateCw size={15} />
                        换一个
                      </Button>
                    )}
                  </div>
                  <div className="focus-body">
                    <span className="focus-domain">
                      {domainPresentation(suggestion.topic.code).name}
                    </span>
                    <h2>
                      {summaries[suggestion.topic.uid]?.title ||
                        suggestion.topic.title}
                    </h2>
                    <p>{suggestion.reason}</p>
                  </div>
                  <div className="focus-bottom">
                    <Button
                      className="quick-copy"
                      onClick={() => {
                        const entry = nodeMap.get(suggestion.topic.uid);
                        if (entry) void copyTopic(entry);
                      }}
                    >
                      <Copy size={17} />
                      复制给教学 AI
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setSelected(suggestion.topic.uid)}
                    >
                      打开主题
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                </section>
              ) : (
                <section className="focus-card">
                  <h2>再发现一个感兴趣的方向</h2>
                  <Button onClick={() => enterCategory(null)}>
                    去目录看看
                    <Compass size={17} />
                  </Button>
                </section>
              )}
              <section className="featured-section">
                <div className="section-heading">
                  <h3>探索一个领域</h3>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSection('all');
                      enterCategory(null);
                    }}
                  >
                    全部领域
                    <ChevronRight size={16} />
                  </Button>
                </div>
                <div className="featured-grid">
                  {featured.map((n) => domainCard(n, true))}
                </div>
              </section>
              <p className="home-footnote">
                选个主题，复制给 AI，学完回来记一笔。
              </p>
            </TabsContent>
            <TabsContent value="catalogue" className="directory-panel">
              {current ? (
                <div
                  className="directory-heading"
                  data-family={sectionOf(current.code)}
                >
                  <div className="scope-nav">
                    <Button
                      variant="ghost"
                      onClick={() => enterCategory(current.parent)}
                    >
                      <ArrowLeft size={17} />
                      上一级
                    </Button>
                    <Button variant="ghost" onClick={() => enterCategory(null)}>
                      全部领域
                    </Button>
                  </div>
                  <span className="eyebrow">
                    {current.code} · {domainPresentation(current.code).name}
                  </span>
                  <h1>{current.title}</h1>
                </div>
              ) : (
                <div className="page-heading">
                  <h1>世界知识目录</h1>
                  <p>选一个领域，再慢慢往里走。</p>
                </div>
              )}
              {search()}
              {query.trim() ? (
                <div className="list-heading">
                  <h3>搜索结果</h3>
                  <span>
                    {paged.total} 个主题{scope ? ' · 当前分类内' : ''}
                  </span>
                </div>
              ) : !scope ? (
                <div className="directory-toolbar">
                  <h3>一级领域</h3>
                  <Select
                    value={section}
                    onValueChange={(value) => {
                      if (value) {
                        setSection(value as CatalogueSection);
                        setPage(1);
                      }
                    }}
                  >
                    <SelectTrigger aria-label="筛选领域分组">
                      <SelectValue>
                        {
                          catalogueSections.find((item) => item.id === section)
                            ?.label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {catalogueSections.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="list-heading">
                  <h3>当前分类</h3>
                  <span>{paged.total} 个下级条目</span>
                </div>
              )}
              {entryList}
            </TabsContent>
            <TabsContent value="learning" className="learning-panel">
              <div className="page-heading">
                <h1>我的学习</h1>
                <p>走过的每一步，都留在这里。</p>
              </div>
              {connection}
              {loadState === 'ready' && (
                <div className="learning-stats">
                  <span>
                    <strong>{learning}</strong>进行中
                  </span>
                  <span>
                    <strong>{learned}</strong>已学过
                  </span>
                  <span>
                    <strong>{stats.filter((s) => s.hasNote).length}</strong>
                    有笔记
                  </span>
                </div>
              )}
              {search()}
              <Tabs
                value={filter}
                onValueChange={(value) => setFilter(String(value))}
              >
                <TabsList className="filter-tabs" aria-label="学习记录筛选">
                  <TabsTrigger value="learning">进行中</TabsTrigger>
                  <TabsTrigger value="learned">已学过</TabsTrigger>
                  <TabsTrigger value="notes">有笔记</TabsTrigger>
                  <TabsTrigger value="all">全部记录</TabsTrigger>
                </TabsList>
              </Tabs>
              {drafts.length > 0 && filter === 'learning' && (
                <div className="draft-list">
                  <strong>待恢复的本机草稿</strong>
                  {drafts.map((d) => (
                    <Button
                      key={d.record.uid}
                      variant="outline"
                      onClick={() => setSelected(d.record.uid)}
                    >
                      {d.record.title || nodeMap.get(d.record.uid)?.title}
                    </Button>
                  ))}
                </div>
              )}
              <div className="list-heading">
                <h3>
                  {filter === 'learning'
                    ? '继续学习'
                    : filter === 'learned'
                      ? '已经学过'
                      : filter === 'notes'
                        ? '笔记记录'
                        : '全部记录'}
                </h3>
                <span>{paged.total} 个主题</span>
              </div>
              {loadState === 'ready' && entryList}
            </TabsContent>
          </section>
          {!mobile && topic && (
            <article className="editor-pane" ref={editorPane}>
              <Button
                variant="ghost"
                className="close-topic"
                onClick={() => setSelected(null)}
                aria-label="关闭主题"
              >
                <X size={19} />
              </Button>
              {editor}
            </article>
          )}
        </main>
      </Tabs>
      {mobile && (
        <Sheet
          open={!!topic}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <SheetContent className="mobile-editor-sheet" showCloseButton={false}>
            <SheetTitle className="sr-only">主题学习笔记</SheetTitle>
            <SheetDescription className="sr-only">
              完成度、知识点和聊天原文
            </SheetDescription>
            <div className="mobile-editor-inner" key={selected}>
              <Button
                variant="ghost"
                className="back-to-list"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft />
                返回
                {view === 'home'
                  ? '首页'
                  : view === 'learning'
                    ? '我的学习'
                    : '目录'}
              </Button>
              {editor}
            </div>
          </SheetContent>
        </Sheet>
      )}
      <Dialog
        open={settings}
        onOpenChange={(open) => {
          if (!busy) setSettings(open);
        }}
      >
        <DialogContent className="settings-dialog">
          <DialogTitle>备份与安卓安装</DialogTitle>
          <DialogDescription>
            免登录，笔记只保存在这个浏览器里。换手机或清理浏览器前，请先导出备份。
          </DialogDescription>
          <section>
            <h3>
              <Smartphone size={20} />
              放到手机桌面
            </h3>
            <p>
              在安卓 Chrome
              打开此网址，使用浏览器菜单中的“安装应用”或“添加到主屏幕”，下次从桌面打开即可。
            </p>
            {install && (
              <Button
                onClick={async () => {
                  await install.prompt();
                  await install.userChoice;
                  setInstall(null);
                }}
              >
                安装学习备忘录
              </Button>
            )}
            <p className="hint">
              这是可安装的网页应用，没有
              APK。初次打开需要联网；已缓存的页面和本机笔记可离线使用，未缓存功能仍需联网加载。
            </p>
          </section>
          <section>
            <h3>学习记录备份</h3>
            <p>
              备份包括标题、完成度、知识点、聊天原文、站内 AI 对话和本机草稿，不包含 Key。换手机或整理大量内容前，可以留一份文件。
            </p>
            <div className="action-row">
              <Button
                disabled={!profile || busy}
                onClick={() => void exportAll()}
              >
                <Download />
                {busy ? '处理中…' : '导出完整备份'}
              </Button>
              <label
                className={`file-button ${busy || !profile ? 'disabled' : ''}`}
              >
                <Upload size={17} />
                选择备份文件
                <input
                  type="file"
                  accept=".json"
                  disabled={busy || !profile}
                  onChange={(e) => {
                    void inspectBackup(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {importPlan && (
              <div className="import-preview">
                <strong>
                  待导入：{importPlan.records.length} 条记录，
                  {importPlan.chats.length} 份对话，{importPlan.drafts.length} 份草稿
                </strong>
                <p>
                  只补充本机缺少的记录，已有记录保留。不同的草稿会在打开主题时提示合并。
                </p>
                {importPlan.unknown > 0 && (
                  <p className="warning">
                    {importPlan.unknown}{' '}
                    条主题不在当前目录，将跳过；原备份文件仍包含它们。
                  </p>
                )}
                <Button disabled={busy} onClick={() => void importAll()}>
                  导入缺少的记录
                </Button>
              </div>
            )}
          </section>
          <section>
            <h3>本机存储</h3>
            <p>
              记录不会自动上传或跨设备同步。定期导出备份，另一台手机可导入接着用。
            </p>
            <Button
              variant="outline"
              disabled={persistent === true}
              onClick={async () => {
                const granted = await navigator.storage
                  ?.persist?.()
                  .catch(() => false);
                setPersistent(!!granted);
                toast.info(
                  granted
                    ? '浏览器已允许持久保存，仍建议保留文件备份'
                    : '浏览器未授予持久保存，请定期导出备份',
                );
              }}
            >
              {persistent ? '已开启持久保存' : '请求浏览器保留数据'}
            </Button>
          </section>

          <section className="scope-note">
            <h3>关于这个目录</h3>
            <p>
              这是综合分类框架的第一轮展开，并非所有知识的全集。人物、物种、作品和地方技艺等具体对象尚未穷尽。每个主题都可以追加知识点，显示名称可自行修改。
            </p>
          </section>
        </DialogContent>
      </Dialog>
    </div>
  );
}
