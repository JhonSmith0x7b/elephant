import type { LibraryArticle, LibraryData } from "./contracts";

export interface LibraryCacheEntry {
  data: LibraryData;
  pending: LibraryData | null;
  newCount: number;
}

type ArticleState = Pick<LibraryArticle, "readAt" | "bookmarkedAt">;
type StateChange = { value: string | null; revision: number };
const libraries = new Map<string, LibraryCacheEntry>();
const listeners = new Set<() => void>();
const stateChanges = new Map<string, Partial<Record<keyof ArticleState, StateChange>>>();
const mustRefresh = new Set<string>();
const appendedLibraries = new Set<string>();
const resetRevisions = new Map<string, number>();
let stateRevision = 0;
let lastBookmarkRevision = 0;
let knownBookmarkCount: number | null = null;

export function subscribeLibraryCache(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

export function getCachedLibrary(key: string): LibraryCacheEntry | null {
  return libraries.get(key) ?? null;
}

export function getArticleStateRevision() {
  return stateRevision;
}

function sameContent(left: LibraryArticle[], right: LibraryArticle[]) {
  const content = (articles: LibraryArticle[]) => articles.map(
    ({ readAt: _readAt, bookmarkedAt: _bookmarkedAt, ...article }) => article,
  );
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

function reconcileState(next: LibraryData, requestRevision: number): LibraryData {
  const incoming: LibraryData = {
    ...next,
    articles: next.articles.map((article) => {
      const changes = stateChanges.get(article.id);
      const patch: Partial<ArticleState> = {};
      for (const field of ["readAt", "bookmarkedAt"] as const) {
        const change = changes?.[field];
        if (change && change.revision > requestRevision) patch[field] = change.value;
      }
      return { ...article, ...patch };
    }),
  };
  if (lastBookmarkRevision > requestRevision && knownBookmarkCount !== null) {
    incoming.counts = { ...incoming.counts, bookmarks: knownBookmarkCount };
  } else {
    knownBookmarkCount = incoming.counts.bookmarks;
  }
  return incoming;
}

export function receiveLibrary(
  key: string,
  next: LibraryData,
  force = false,
  requestRevision = stateRevision,
) {
  const incoming = reconcileState(next, requestRevision);
  const requiresRefresh = mustRefresh.delete(key);
  const previous = libraries.get(key);
  let entry: LibraryCacheEntry;
  if (!previous || force || requiresRefresh) {
    entry = { data: incoming, pending: null, newCount: 0 };
    appendedLibraries.delete(key);
    resetRevisions.set(key, ++stateRevision);
  } else if (
    previous.data.articleCount === incoming.articleCount
    && sameContent(previous.data.articles.slice(0, incoming.articles.length), incoming.articles)
  ) {
    const appended = appendedLibraries.has(key);
    entry = {
      data: {
        ...incoming,
        articles: [...incoming.articles, ...previous.data.articles.slice(incoming.articles.length)],
        nextCursor: appended ? previous.data.nextCursor : incoming.nextCursor,
      },
      pending: null,
      newCount: 0,
    };
  } else {
    const incomingById = new Map(incoming.articles.map((article) => [article.id, article]));
    const displayedIds = new Set(previous.data.articles.map((article) => article.id));
    entry = {
      data: {
        ...incoming,
        articleCount: previous.data.articleCount,
        nextCursor: previous.data.nextCursor,
        articles: previous.data.articles.map((article) => {
          const updated = incomingById.get(article.id);
          return updated
            ? { ...article, readAt: updated.readAt, bookmarkedAt: updated.bookmarkedAt }
            : article;
        }),
      },
      pending: incoming,
      newCount: incoming.articles.filter((article) => !displayedIds.has(article.id)).length,
    };
  }
  libraries.delete(key);
  libraries.set(key, entry);
  if (libraries.size > 20) {
    const oldest = libraries.keys().next().value!;
    libraries.delete(oldest);
    appendedLibraries.delete(oldest);
    resetRevisions.delete(oldest);
  }
  notify();
}

export function appendLibraryPage(
  key: string,
  page: LibraryData,
  expectedCursor: string,
  requestRevision = stateRevision,
): boolean {
  const entry = libraries.get(key);
  if (!entry || mustRefresh.has(key) || entry.data.nextCursor !== expectedCursor
    || requestRevision < (resetRevisions.get(key) ?? 0)) return false;
  const incoming = reconcileState(page, requestRevision);
  const displayedIds = new Set(entry.data.articles.map((article) => article.id));
  const additional = incoming.articles.filter((article) => {
    if (displayedIds.has(article.id)) return false;
    displayedIds.add(article.id);
    return true;
  });
  libraries.set(key, {
    ...entry,
    data: {
      ...entry.data,
      articles: [...entry.data.articles, ...additional],
      nextCursor: incoming.nextCursor,
    },
  });
  appendedLibraries.add(key);
  notify();
  return true;
}

export function applyPendingLibrary(key: string) {
  const entry = libraries.get(key);
  if (!entry?.pending) return;
  libraries.set(key, { data: entry.pending, pending: null, newCount: 0 });
  appendedLibraries.delete(key);
  resetRevisions.set(key, ++stateRevision);
  notify();
}

export function patchCachedArticle(
  id: string,
  patch: Partial<ArticleState>,
  previousState?: Partial<ArticleState>,
) {
  const changes = stateChanges.get(id) ?? {};
  const existing = [...libraries.values()].flatMap((entry) => [
    ...entry.data.articles, ...(entry.pending?.articles ?? []),
  ]).find((article) => article.id === id);
  const oldBookmark = previousState?.bookmarkedAt !== undefined
    ? previousState.bookmarkedAt
    : existing !== undefined ? existing.bookmarkedAt : changes.bookmarkedAt?.value;
  const bookmarkDelta = patch.bookmarkedAt === undefined || oldBookmark === undefined
    ? 0 : Number(Boolean(patch.bookmarkedAt)) - Number(Boolean(oldBookmark));
  stateRevision += 1;
  if (patch.bookmarkedAt !== undefined) {
    lastBookmarkRevision = stateRevision;
    if (knownBookmarkCount !== null) knownBookmarkCount = Math.max(0, knownBookmarkCount + bookmarkDelta);
  }
  for (const field of ["readAt", "bookmarkedAt"] as const) {
    if (patch[field] !== undefined) changes[field] = { value: patch[field], revision: stateRevision };
  }
  stateChanges.set(id, changes);
  const update = (data: LibraryData): LibraryData => ({
    ...data,
    articles: data.articles.map((article) => article.id === id ? { ...article, ...patch } : article),
    counts: { ...data.counts, bookmarks: knownBookmarkCount ?? Math.max(0, data.counts.bookmarks + bookmarkDelta) },
  });
  for (const [key, entry] of libraries) {
    libraries.set(key, { ...entry, data: update(entry.data), pending: entry.pending ? update(entry.pending) : null });
  }
  notify();
}

export function invalidateOtherLibraries(key: string) {
  mustRefresh.add(key);
  for (const cachedKey of libraries.keys()) {
    if (cachedKey !== key) {
      libraries.delete(cachedKey);
      appendedLibraries.delete(cachedKey);
      resetRevisions.delete(cachedKey);
    }
  }
  notify();
}

export function clearLibraryCache() {
  libraries.clear();
  stateChanges.clear();
  mustRefresh.clear();
  appendedLibraries.clear();
  resetRevisions.clear();
  knownBookmarkCount = null;
  lastBookmarkRevision = 0;
  stateRevision += 1;
  notify();
}
