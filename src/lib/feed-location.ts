export interface FeedLocation {
  channel: string;
  source: string;
  view: "list" | "cards";
}

export function readFeedLocation(params: Pick<URLSearchParams, "get">): FeedLocation {
  return {
    channel: params.get("channel") || "all",
    source: params.get("source") || "all",
    view: params.get("layout") === "cards" ? "cards" : "list",
  };
}

export function feedHref(location: FeedLocation): string {
  const params = new URLSearchParams();
  if (location.channel !== "all") params.set("channel", location.channel);
  if (location.source !== "all") params.set("source", location.source);
  if (location.view === "cards") params.set("layout", "cards");
  return params.size ? `/?${params}` : "/";
}

export function libraryHref(location: Pick<FeedLocation, "channel" | "source">): string {
  const params = new URLSearchParams();
  if (location.channel !== "all") params.set("channel", location.channel);
  if (location.source !== "all") params.set("source", location.source);
  return params.size ? `/api/library?${params}` : "/api/library";
}

// Article return links can only target the reader, never an arbitrary URL.
export function feedReturnHref(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !/^\/(?:\?|$)/.test(value)) return "/";
  return feedHref(readFeedLocation(new URLSearchParams(value.slice(2))));
}

export function articleSourceId(source: unknown, from?: unknown): string | undefined {
  const candidate = typeof source === "string" ? source
    : readFeedLocation(new URLSearchParams(feedReturnHref(from).slice(2))).source;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate : undefined;
}

export function articleHref(id: string, returnTo = "/", sourceId?: string): string {
  const params = new URLSearchParams();
  const from = feedReturnHref(returnTo);
  if (from !== "/") params.set("from", from);
  if (sourceId) params.set("source", sourceId);
  return `/articles/${encodeURIComponent(id)}${params.size ? `?${params}` : ""}`;
}
