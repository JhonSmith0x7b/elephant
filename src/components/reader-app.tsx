"use client";

import { ThemeSelect } from "./theme-provider";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { feedHref, libraryHref, readFeedLocation, type FeedLocation } from "@/lib/feed-location";
import BrandWordmark from "@/components/brand-wordmark";
import ArticleCard from "@/components/article-card";
import FeedNavigation from "@/components/feed-navigation";
import FeedReadingMap from "@/components/feed-reading-map";
import ChannelManager from "@/components/channel-manager";
import SyncSettings from "@/components/sync-settings";
import {
  appendLibraryPage, applyPendingLibrary, clearLibraryCache, getArticleStateRevision, getCachedLibrary,
  invalidateOtherLibraries, receiveLibrary, subscribeLibraryCache,
} from "@/lib/feed-cache";
import "./channel-manager.css";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  PencilLine,
  RefreshCw,
  Rss,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";

import type {
  SourceChannel as Channel,
  LibrarySource as Source,
  LibraryData as Library,
  FeedPreview as Preview,
  ImportResult,
  ChannelRecord,
  SourceRecord,
} from "@/lib/contracts";
// Only keep return positions for cached feeds in this browser session.
const feedReturnPositions = new Map<string, number>();

const presets = [
  { name: "Lit Hub", url: "https://lithub.com/feed/", note: "文学新闻、访谈与观点" },
  { name: "Book Marks", url: "https://bookmarks.reviews/feed/", note: "新书书评、榜单与阅读" },
];

function dateLabel(value: string | null, includeTime = false) {
  if (!value || Number.isNaN(Date.parse(value))) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } as const : {}),
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...options });
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
    throw new Error("暂时无法连接服务，请检查网络后重试。");
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    clearLibraryCache();
    window.location.assign("/login");
  }
  if (!response.ok) {
    throw new Error(body?.error || "服务暂时无法处理请求，请稍后重试。");
  }
  if (!body) throw new Error("服务返回了无法读取的内容，请重试。");
  return body as T;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return "请求超时，请稍后重试；已缓存的文章仍可阅读。";
  }
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

export default function ReaderApp() {
  const mastheadRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const [lastLibrary, setLastLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const searchParams = useSearchParams();
  const requestedLocation = readFeedLocation(searchParams);
  const requestedLibrary = libraryHref(requestedLocation);
  const snapshot = useSyncExternalStore(subscribeLibraryCache,
    () => getCachedLibrary(requestedLibrary), () => null);
  const library = snapshot?.data ?? lastLibrary;
  const libraryRequest = useRef(0);
  const previousLibrary = useRef(requestedLibrary);
  const autoApplyLibrary = useRef<string | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  const moreSentinel = useRef<HTMLDivElement>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const resetMore = useCallback(() => {
    moreRequest.current?.abort();
    moreRequest.current = null;
    setLoadingMore(false);
    setMoreError("");
  }, []);
  const feedReady = snapshot !== null;
  const channel = library && !library.channels.some(item => item.id === requestedLocation.channel)
    ? "all" : requestedLocation.channel;
  const sourceId = library && !library.sources.some(item => item.id === requestedLocation.source &&
    (channel === "all" || item.channel === channel)) ? "all" : requestedLocation.source;
  const view = requestedLocation.view;
  const returnTo = feedHref({ channel, source: sourceId, view });

  const navigateFeed = (changes: Partial<FeedLocation>, replace = false) => {
    const current = readFeedLocation(new URLSearchParams(window.location.search));
    const href = feedHref({ ...current, ...changes });
    if (href === `${window.location.pathname}${window.location.search}`) return;
    // Next.js synchronizes native history updates with useSearchParams.
    // Browser back/forward restores the scope and triggers its article query.
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  };
  const [showSources, setShowSources] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [movingSourceId, setMovingSourceId] = useState<string | null>(null);
  const [sourceMoveError, setSourceMoveError] = useState<{ id: string; message: string } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [sourceToDelete, setSourceToDelete] = useState<Source | null>(null);
  const [deletingSource, setDeletingSource] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [sourceDeleteError, setSourceDeleteError] = useState("");
  const sourceActionPending = useRef(false);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const sourceToggleRef = useRef<HTMLButtonElement>(null);
  const individualSourceBusy = refreshingId !== null || movingSourceId !== null || deletingSource;
  const sourceBusy = individualSourceBusy || syncBusy;
  const [notice, setNotice] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [importChannel, setImportChannel] = useState<Channel>("literature");
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const previewRequest = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const loadLibrary = useCallback(async (signal?: AbortSignal, force = false) => {
    // Read the current URL even after an import or source change has navigated.
    const url = libraryHref(readFeedLocation(new URLSearchParams(window.location.search)));
    if (force) resetMore();
    const requestId = ++libraryRequest.current;
    const stateRevision = getArticleStateRevision();
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    const isCurrent = () => !signal?.aborted && requestId === libraryRequest.current
      && url === libraryHref(readFeedLocation(new URLSearchParams(window.location.search)));
    setLoading(true);
    setLibraryError("");
    try {
      const next = await request<Library>(url, { signal: requestSignal });
      if (isCurrent()) {
        receiveLibrary(url, next, force, stateRevision);
        if (autoApplyLibrary.current === url) {
          resetMore();
          applyPendingLibrary(url);
          autoApplyLibrary.current = null;
        }
        setLastLibrary(next);
      }
    } catch (error) {
      if (isCurrent()) {
        setLibraryError(errorMessage(error));
        throw error;
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [resetMore]);

  const onSourcesSynced = useCallback(() => {
    void loadLibrary().catch(() => undefined);
  }, [loadLibrary]);

  useEffect(() => {
    const switched = previousLibrary.current !== requestedLibrary;
    previousLibrary.current = requestedLibrary;
    if (switched) {
      // Entering a different scope is a fresh reading intent. Apply cached
      // updates now and the next response automatically; ordinary polls wait.
      autoApplyLibrary.current = requestedLibrary;
      resetMore();
      applyPendingLibrary(requestedLibrary);
    }
    const controller = new AbortController();
    loadLibrary(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [loadLibrary, requestedLibrary, resetMore]);

  const loadMore = useCallback(async () => {
    const previous = getCachedLibrary(requestedLibrary);
    const cursor = previous?.data.nextCursor;
    if (!cursor || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    const revision = getArticleStateRevision();
    setLoadingMore(true);
    setMoreError("");
    try {
      const url = new URL(requestedLibrary, window.location.origin);
      url.searchParams.set("cursor", cursor);
      const page = await request<Library>(`${url.pathname}${url.search}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (!controller.signal.aborted) appendLibraryPage(requestedLibrary, page, cursor, revision);
    } catch (error) {
      if (!controller.signal.aborted) setMoreError(errorMessage(error));
    } finally {
      if (moreRequest.current === controller) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  }, [requestedLibrary]);

  useEffect(() => {
    resetMore();
    return () => { moreRequest.current?.abort(); moreRequest.current = null; };
  }, [requestedLibrary, resetMore]);

  useEffect(() => {
    const sentinel = moreSentinel.current;
    if (!sentinel || !feedReady || !snapshot?.data.nextCursor || loadingMore || moreError) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "800px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [feedReady, snapshot?.data.nextCursor, loadingMore, moreError, loadMore]);

  useEffect(() => {
    if (!feedReady) return;
    const key = feedHref(readFeedLocation(new URLSearchParams(window.location.search)));
    const position = feedReturnPositions.get(key);
    if (position === undefined) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: position, behavior: "instant" });
      feedReturnPositions.delete(key);
    });
    return () => cancelAnimationFrame(frame);
  }, [feedReady, requestedLibrary, view]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") loadLibrary().catch(() => undefined);
    };
    const timer = window.setInterval(refreshOnReturn, 60_000);
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) refreshOnReturn(); };
    window.addEventListener("focus", refreshOnReturn);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [loadLibrary]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modalOpen && !dialog.open) dialog.showModal();
    if (!modalOpen && dialog.open) dialog.close();
  }, [modalOpen]);

  useEffect(() => () => previewRequest.current?.abort(), []);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (sourceToDelete && !dialog.open) {
      dialog.showModal();
      deleteCancelRef.current?.focus();
    } else if (!sourceToDelete && dialog.open) {
      dialog.close();
      const trigger = deleteTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else sourceToggleRef.current?.focus();
    }
  }, [sourceToDelete]);

  const openImport = (url = "") => {
    previewRequest.current?.abort();
    setFeedUrl(url);
    setPreview(null);
    setSourceName("");
    setImportError("");
    setPreviewing(false);
    setImportChannel(channel === "all" ? library?.channels[0]?.id ?? "literature" : channel);
    setModalOpen(true);
  };

  const closeImport = () => {
    if (importing) return;
    previewRequest.current?.abort();
    previewRequest.current = null;
    setModalOpen(false);
    setPreviewing(false);
  };

  const changeUrl = (url: string) => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setFeedUrl(url);
    setPreview(null);
    setImportError("");
    setPreviewing(false);
  };

  const fetchPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (previewing || importing || !feedUrl.trim()) return;
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewing(true);
    setImportError("");
    setPreview(null);
    try {
      const next = await request<Preview>("/api/feeds/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: feedUrl.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || previewRequest.current !== controller) return;
      setPreview(next);
      setSourceName(next.feed.title);
    } catch (error) {
      if (!controller.signal.aborted) setImportError(errorMessage(error));
    } finally {
      if (previewRequest.current === controller) setPreviewing(false);
    }
  };

  const confirmImport = async () => {
    if (!preview || !sourceName.trim() || importing) return;
    setImporting(true);
    setImportError("");
    try {
      const result = await request<ImportResult>("/api/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewId: preview.previewId, name: sourceName.trim(), channel: importChannel }),
      });
      navigateFeed({ channel: importChannel, source: "all" });
      setModalOpen(false);
      setNotice(`已导入 ${sourceName.trim()}，新增 ${result.insertedCount} 篇文章。`);
      invalidateOtherLibraries(libraryHref(readFeedLocation(new URLSearchParams(window.location.search))));
      await loadLibrary(undefined, true).catch((error: unknown) => setLibraryError(errorMessage(error)));
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const refreshSource = async (source: Source) => {
    if (sourceActionPending.current) return;
    sourceActionPending.current = true;
    setRefreshingId(source.id);
    setLibraryError("");
    setNotice("");
    try {
      const result = await request<ImportResult>(`/api/feeds/${encodeURIComponent(source.id)}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setNotice(result.insertedCount > 0
        ? `${source.name} 已刷新，新增 ${result.insertedCount} 篇文章。`
        : `${source.name} 已刷新，暂无新文章。`);
      await loadLibrary();
    } catch (error) {
      const message = errorMessage(error);
      await loadLibrary().catch(() => undefined);
      setLibraryError(message);
    } finally {
      sourceActionPending.current = false;
      setRefreshingId(null);
    }
  };

  const retryLibrary = async () => {
    setLoading(true);
    setLibraryError("");
    try { await loadLibrary(); }
    catch (error) { setLibraryError(errorMessage(error)); }
    finally { setLoading(false); }
  };

  const updateChannel = async (_updated: ChannelRecord) => {
    // The mutation has already succeeded; refetch metadata without retaining
    // stale category/source scopes elsewhere in the browser cache.
    invalidateOtherLibraries(requestedLibrary);
    await loadLibrary(undefined, true).catch((error: unknown) => setLibraryError(errorMessage(error)));
  };

  const moveSource = async (source: Source, nextChannel: string) => {
    if (sourceActionPending.current || source.channel === nextChannel) return;
    sourceActionPending.current = true;
    setMovingSourceId(source.id);
    setSourceMoveError(null);
    try {
      const { source: updated } = await request<{ source: SourceRecord }>(`/api/feeds/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: nextChannel }),
        signal: AbortSignal.timeout(20_000),
      });
      if (sourceId === source.id && channel !== "all" && channel !== updated.channel) navigateFeed({ source: "all" }, true);
      setNotice(`已将 ${source.name} 及其收录文章归入「${updated.channelName}」。`);
      invalidateOtherLibraries(libraryHref(readFeedLocation(new URLSearchParams(window.location.search))));
      await loadLibrary(undefined, true).catch((error: unknown) => setLibraryError(errorMessage(error)));
    } catch (error) {
      setSourceMoveError({ id: source.id, message: error instanceof Error && error.name === "TimeoutError" ? "请求超时，请稍后重试。" : errorMessage(error) });
    } finally {
      sourceActionPending.current = false;
      setMovingSourceId(null);
    }
  };

  const openSourceDelete = (source: Source, trigger: HTMLButtonElement) => {
    if (sourceActionPending.current) return;
    deleteTriggerRef.current = trigger;
    setSourceDeleteError("");
    setSourceToDelete(source);
  };

  const closeSourceDelete = () => {
    if (sourceActionPending.current) return;
    setSourceToDelete(null);
    setSourceDeleteError("");
  };

  const confirmSourceDelete = async () => {
    if (!sourceToDelete || sourceActionPending.current) return;
    sourceActionPending.current = true;
    const source = sourceToDelete;
    setDeletingSource(true);
    setSourceDeleteError("");
    try {
      await request<{ sourceId: string }>(`/api/feeds/${encodeURIComponent(source.id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(20_000),
      });
      if (readFeedLocation(new URLSearchParams(window.location.search)).source === source.id) {
        navigateFeed({ source: "all" }, true);
      }
      setSourceToDelete(null);
      setNotice(`已删除 ${source.name}，已存文章和收藏仍然保留。`);
      invalidateOtherLibraries(libraryHref(readFeedLocation(new URLSearchParams(window.location.search))));
      await loadLibrary(undefined, true).catch(() => undefined);
    } catch (error) {
      setSourceDeleteError(error instanceof Error && error.name === "TimeoutError"
        ? "请求超时，请稍后重试。" : errorMessage(error));
    } finally {
      sourceActionPending.current = false;
      setDeletingSource(false);
    }
  };

  const availableSources = (library?.sources ?? []).filter((source) => channel === "all" || source.channel === channel);
  const channels = [{ id: "all", name: "总览" }, ...(library?.channels ?? [])];
  // The API selects both content and attribution for the requested source.
  const articles = library?.articles ?? [];
  const activeName = channels.find((item) => item.id === channel)?.name;
  const existingSource = preview && library?.sources.find((source) => source.feedUrl === preview.feed.url);

  return (
    <div className="reading-room reader-custom-channels">
      {feedReady && library && <FeedReadingMap key={requestedLibrary} articles={library.articles} />}
      <FeedNavigation mastheadRef={mastheadRef} headingRef={headingRef}
        channels={channels} channel={channel}
        onSelect={id => navigateFeed({ channel: id, source: "all" })} />
      <header ref={mastheadRef} className="masthead">
        <div className="masthead-top"><span>阅读，把世界慢慢展开。</span><div className="masthead-top-tools"><span>私人信息流</span><ThemeSelect /></div></div>
        <div className="masthead-main">
          <button className="brand" onClick={() => navigateFeed({ channel: "all", source: "all" })} aria-label="大象，返回总览">
            <BrandWordmark />
          </button>
          <div className="channel-nav-group"><nav className="channel-nav" aria-label="内容板块">
            {channels.map((item) => (
              <button key={item.id} title={item.name} aria-pressed={channel === item.id} onClick={() => navigateFeed({ channel: item.id, source: "all" })}>
                <span className="channel-nav-label">{item.name}</span>
              </button>
            ))}
          </nav><button className="text-button channel-manage-trigger" aria-label="管理分类" title="管理分类" onClick={() => setShowChannels(true)} disabled={!library}><PencilLine size={14} /><span>管理分类</span></button></div>
          <div className="masthead-actions">
            <Link className="text-button bookmarks-nav-link" href="/bookmarks" prefetch={false}><Bookmark size={15} /><span>我的收藏</span>{library && library.counts.bookmarks > 0 && <span className="bookmarks-nav-count">{library.counts.bookmarks}</span>}</Link>
            <button ref={sourceToggleRef} className="text-button source-toggle" aria-label="管理来源" onClick={() => setShowSources(!showSources)} aria-expanded={showSources} aria-controls="sources-panel">
              <SlidersHorizontal size={15} /><span>管理来源</span>
            </button>
            <button className="button primary import-button" onClick={() => openImport()}><Plus size={16} />导入 RSS</button>
          </div>
        </div>
      </header>

      <main>
        <div ref={headingRef} className="section-heading">
          <div className="section-heading-title"><h1>{channel === "all" || !activeName ? "我的信息流" : `${activeName}·阅览`}</h1>
            <span className="section-caption">{library ? `${library.counts.sources} 个来源 · ${library.counts.articles} 篇收录` : "从一个好来源开始"}</span>
          </div>
          <div className="feed-update-area">
            {feedReady && <button className={`feed-update-button${snapshot?.pending ? " has-updates" : ""}`}
              disabled={loading && !snapshot?.pending} aria-busy={loading && !snapshot?.pending}
              onClick={() => {
                if (snapshot?.pending) { resetMore(); applyPendingLibrary(requestedLibrary); setLibraryError(""); }
                else void loadLibrary().catch(() => undefined);
              }}>
              <RefreshCw size={13} className={loading && !snapshot?.pending ? "spinning" : undefined} aria-hidden="true" />
              <span aria-live="polite">{snapshot?.pending
                ? snapshot.newCount > 0 ? `${snapshot.newCount} 篇新内容 · 点击显示` : "内容有更新 · 点击显示"
                : loading ? "检查更新中" : "检查更新"}</span>
            </button>}
            <span className="section-english">READING, AT YOUR PACE</span>
          </div>
        </div>

        {notice && <div className="notice" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        {libraryError && <div className="error-message library-error" role="alert"><span>{libraryError}</span><button className="text-button" onClick={retryLibrary} disabled={loading}>重新加载</button></div>}

        {showSources && <section id="sources-panel" className="sources-panel" aria-labelledby="sources-heading">
          <div className="panel-heading"><div><h2 id="sources-heading">我的信息源</h2><p>设置周期同步，或随时手动刷新来源。</p></div><span className="small-label">RSS / ATOM</span></div>
          <SyncSettings onSynced={onSourcesSynced} onBusyChange={setSyncBusy} disabled={individualSourceBusy} />
          {library?.sources.length ? <div className="source-list">{library.sources.map((source) => (
            <div className="source-row" key={source.id}>
              <div className="source-symbol"><Rss size={19} /></div>
              <div className="source-info"><div className="source-name-row"><h3>{source.name}</h3><span className="source-channel">{source.channelName}</span></div>
                <a className="source-url" href={source.feedUrl} target="_blank" rel="noopener noreferrer">{source.feedUrl}<ArrowUpRight size={12} /></a>
                <p className="source-meta">{source.articleCount} 篇收录 <span>·</span> {source.lastFetchedAt ? `最近同步 ${dateLabel(source.lastFetchedAt, true)}` : "尚未同步"}</p>
                {source.lastError && <p className="source-error">最近同步未完成：{source.lastError}</p>}
                <div className="source-channel-editor"><label htmlFor={`source-channel-${source.id}`}>所属分类</label><select id={`source-channel-${source.id}`} aria-label={`${source.name}所属分类`} value={source.channel} onChange={event => moveSource(source, event.target.value)} disabled={sourceBusy}>{library.channels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{movingSourceId === source.id && <LoaderCircle size={13} className="spinning" aria-label="正在调整分类" />}</div>
                {sourceMoveError?.id === source.id && <p className="source-error" role="alert">{sourceMoveError.message}</p>}
              </div>
              <div className="source-actions"><button className="button secondary source-refresh" onClick={() => refreshSource(source)} disabled={sourceBusy} aria-label={`刷新 ${source.name}`}>
                {refreshingId === source.id ? <LoaderCircle size={14} className="spinning" /> : <RefreshCw size={14} />}<span>{refreshingId === source.id ? "刷新中" : "刷新"}</span>
              </button><button className="text-button source-delete" onClick={event => openSourceDelete(source, event.currentTarget)} disabled={sourceBusy} aria-label={`删除 ${source.name}`}><Trash2 size={14} /><span>删除</span></button></div>
            </div>
          ))}</div> : <p className="source-panel-empty">还没有信息源。导入一个 RSS 订阅地址，就可以在这里管理。</p>}
        </section>}

        {!feedReady && (loading || !libraryError) ? <div className="loading-state" role="status"><LoaderCircle className="spinning" size={22} /><p>{library ? "正在加载文章…" : "正在打开大象…"}</p></div> : library && feedReady && library.counts.articles === 0 && library.sources.length === 0 ? (
          <section className="empty-state">
            <BookOpen size={34} strokeWidth={1.2} />
            <span className="small-label">YOUR FIRST SOURCE</span>
            <h2>从你想读的内容开始</h2>
            <p>把喜欢的媒体放进同一份信息流。<br />导入 RSS 后，新文章会在这里展开。</p>
            <div className="preset-cards">{presets.map((preset) => <button key={preset.url} className="preset-card" onClick={() => openImport(preset.url)}>
              <div><span>{preset.name}</span><ArrowUpRight size={16} /></div><p>{preset.note}</p><span className="preset-card-action"><Plus size={13} />导入这个来源</span>
            </button>)}</div>
            <button className="text-button other-source" onClick={() => openImport()}>或导入其他 RSS 地址<ArrowUpRight size={14} /></button>
          </section>
        ) : library && feedReady ? <>
          <div className="feed-toolbar">
            <div className="source-filter"><label htmlFor="source-filter">来源</label><div className="select-wrapper"><select id="source-filter" value={sourceId} onChange={(event) => navigateFeed({ source: event.target.value })}>
              <option value="all">全部来源</option>{availableSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select><ChevronDown size={13} /></div><span className="article-count">{library.articleCount > articles.length ? `${articles.length} / ${library.articleCount}` : articles.length} 篇</span></div>
            <div className="view-switch" aria-label="信息流布局"><button className="text-button" aria-label="卡片" aria-pressed={view === "cards"} onClick={() => navigateFeed({ view: "cards" }, true)}><LayoutGrid size={14} /><span>卡片</span></button><button className="text-button" aria-label="列表" aria-pressed={view === "list"} onClick={() => navigateFeed({ view: "list" }, true)}><List size={16} /><span>列表</span></button></div>
          </div>
          {articles.length ? <div className={`article-feed ${view}`} onClickCapture={event => {
            const link = (event.target as HTMLElement).closest("a");
            if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
              && link?.getAttribute("href")?.startsWith("/articles/")) {
              feedReturnPositions.set(returnTo, window.scrollY);
              if (feedReturnPositions.size > 20) feedReturnPositions.delete(feedReturnPositions.keys().next().value!);
            }
          }}>
            {articles.map((article) => <ArticleCard key={article.id} article={article} returnTo={returnTo} />)}
          </div> : <div className="empty-filter"><BookOpen size={28} strokeWidth={1.3} /><h2>这里还没有文章</h2><p>{availableSources.length ? "可以在来源管理中刷新订阅，或查看其他来源。" : `为${activeName}板块导入一个来源，开始这部分的阅读。`}</p><button className="button secondary" onClick={() => openImport()}><Plus size={14} />导入 RSS</button></div>}
          <div ref={moreSentinel} className="feed-end" aria-live="polite">
            {library.nextCursor ? <>
              {moreError && <p role="alert">{moreError}</p>}
              <button className="text-button feed-load-more" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore && <LoaderCircle size={14} className="spinning" aria-hidden="true" />}
                {loadingMore ? "正在加载更多…" : moreError ? "点击重试" : "加载更多"}
              </button>
            </> : "— 已经到底了 —"}
          </div>
        </> : !loading && <div className="empty-filter"><BookOpen size={28} strokeWidth={1.3} /><h2>暂时没能打开信息流</h2><p>请稍后重新加载，已有内容不会因此丢失。</p></div>}
      </main>

      <footer className="page-footer"><span>大象 <span className="footer-divider">/</span> 留一点时间，给阅读。</span><span>文章保留原文出处 · 当前支持 RSS / Atom</span></footer>

      <ChannelManager open={showChannels} channels={library?.channels ?? []} onClose={() => setShowChannels(false)} onChange={updateChannel} />

      <dialog ref={deleteDialogRef} className="import-dialog source-delete-dialog" aria-labelledby="source-delete-heading" aria-describedby="source-delete-description"
        onCancel={event => { event.preventDefault(); closeSourceDelete(); }}
        onClick={event => { if (event.target === event.currentTarget) closeSourceDelete(); }}>
        <div className="dialog-content">
          <div className="dialog-heading"><div><span className="small-label">MANAGE YOUR SOURCES</span><h2 id="source-delete-heading">删除这个来源？</h2></div><button className="icon-button" onClick={closeSourceDelete} aria-label="关闭删除窗口" disabled={deletingSource}><X size={20} /></button></div>
          <div className="source-delete-details"><strong>{sourceToDelete?.name}</strong><p>{sourceToDelete?.feedUrl}</p></div>
          <p className="dialog-intro" id="source-delete-description">删除后，这个来源将停止更新。已存文章和收藏都会保留，仍可在信息流和收藏中阅读。以后重新导入同一地址，即可恢复订阅。</p>
          {sourceDeleteError && <div className="error-message" role="alert">{sourceDeleteError}</div>}
          <div className="dialog-footer source-delete-footer"><button ref={deleteCancelRef} className="button secondary" onClick={closeSourceDelete} disabled={deletingSource}>取消</button><button className="button primary" onClick={confirmSourceDelete} disabled={deletingSource} aria-busy={deletingSource}>{deletingSource ? <LoaderCircle size={15} className="spinning" /> : <Trash2 size={15} />}{deletingSource ? "正在删除" : "删除来源"}</button></div>
        </div>
      </dialog>

      <dialog ref={dialogRef} className="import-dialog" aria-labelledby="import-heading" onCancel={(event) => { event.preventDefault(); closeImport(); }} onClick={(event) => { if (event.target === event.currentTarget) closeImport(); }}>
        <div className="dialog-content">
          <div className="dialog-heading"><div><span className="small-label">ADD A SOURCE</span><h2 id="import-heading">导入 RSS 信息源</h2></div><button className="icon-button" onClick={closeImport} aria-label="关闭导入窗口" disabled={importing}><X size={20} /></button></div>
          <p className="dialog-intro">粘贴订阅地址，先预览内容，再放进你的信息流。</p>
          <form onSubmit={fetchPreview}>
            <label className="field-label" htmlFor="feed-url">RSS / Atom 地址</label>
            <div className="url-input-row"><input autoFocus id="feed-url" type="url" required placeholder="https://example.com/feed/" value={feedUrl} onChange={(event) => changeUrl(event.target.value)} disabled={importing} autoComplete="off" /><button className="button secondary preview-button" type="submit" disabled={!feedUrl.trim() || previewing || importing}>{previewing ? <LoaderCircle size={15} className="spinning" /> : <Rss size={15} />}{previewing ? "读取中" : "预览来源"}</button></div>
            <div className="quick-presets"><span>试一试</span>{presets.map((preset) => <button type="button" key={preset.url} onClick={() => changeUrl(preset.url)} disabled={importing}>{preset.name}<ArrowUpRight size={12} /></button>)}</div>
          </form>
          {importError && <div className="error-message" role="alert">{importError}</div>}
          {previewing && <div className="preview-loading" role="status"><LoaderCircle size={19} className="spinning" /><span>正在读取订阅源，整理最新内容…</span></div>}
          {preview && <section className="feed-preview" aria-label="来源预览">
            <div className="preview-status"><Check size={14} /><span>已读取订阅源</span><span className="preview-count">当前提供 {preview.feed.itemCount} 篇</span></div>
            <div className="preview-fields"><div><label className="field-label" htmlFor="source-name">来源名称</label><input id="source-name" value={sourceName} onChange={(event) => setSourceName(event.target.value)} maxLength={120} disabled={importing} /></div><div><label className="field-label" htmlFor="import-channel">放入板块</label><select id="import-channel" value={importChannel} onChange={(event) => setImportChannel(event.target.value as Channel)} disabled={importing}>{channels.filter((item) => item.id !== "all").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div>
            {preview.feed.description && <p className="preview-description">{preview.feed.description}</p>}
            <div className="preview-articles"><span className="small-label">内容预览</span>{preview.feed.items.slice(0, 3).map((item, index) => <div className="preview-article" key={`${index}-${item.title}`}><span className="preview-number">0{index + 1}</span><div><p>{item.title}</p><span>{item.publishedAt ? dateLabel(item.publishedAt) : "未提供发布时间"}</span></div></div>)}{preview.feed.itemCount === 0 && <p className="empty-preview">订阅源有效，目前没有文章。导入后可以手动刷新。</p>}</div>
            {existingSource && <p className="existing-source">这个订阅地址已在大象中，重复导入不会产生重复文章。</p>}
          </section>}
          <div className="dialog-footer"><span>{preview ? "仅导入订阅源当前提供的内容" : "支持标准 RSS 和 Atom 订阅"}</span><button className="button primary" onClick={confirmImport} disabled={!preview || !sourceName.trim() || importing}>{importing ? <LoaderCircle className="spinning" size={15} /> : <ArrowDownToLine size={15} />}{importing ? "正在导入" : "确认导入"}</button></div>
        </div>
      </dialog>
    </div>
  );
}
