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

export function articleHref(id: string, returnTo = "/"): string {
  const params = new URLSearchParams();
  const from = feedReturnHref(returnTo);
  if (from !== "/") params.set("from", from);
  return `/articles/${encodeURIComponent(id)}${params.size ? `?${params}` : ""}`;
}
