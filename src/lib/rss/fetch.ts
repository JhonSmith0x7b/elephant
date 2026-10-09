import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { RssError } from "./types";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(address, prefix, "ipv4");

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], // Protocol assignments, including Teredo and benchmarking.
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blockedIpv6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) {
    return globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6");
  }
  return false;
}

function normalizedHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isLocalFeedHost(hostname: string): boolean {
  return !process.env.VERCEL
    && (process.env.RSS_LOCAL_FEED_HOSTS ?? "").split(",")
      .some(host => host.trim() !== "" && normalizedHost(host.trim()) === normalizedHost(hostname));
}

const localAddresses = new BlockList();
for (const [address, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) {
  localAddresses.addSubnet(address, prefix, "ipv4");
}
localAddresses.addAddress("::1", "ipv6");
localAddresses.addSubnet("fc00::", 7, "ipv6");

const tailscaleAddresses = new BlockList();
tailscaleAddresses.addSubnet("100.64.0.0", 10, "ipv4");

function isAllowedAddress(address: string, hostname: string) {
  if (isPublicAddress(address)) return true;
  const family = isIP(address);
  if (!isLocalFeedHost(hostname)) return false;
  // Only explicitly listed Tailscale names may use CGNAT addresses.
  // Alibaba metadata also uses this range and must remain inaccessible.
  if (family === 4 && normalizedHost(hostname).endsWith(".ts.net")
    && address !== "100.100.100.200" && tailscaleAddresses.check(address, "ipv4")) return true;
  return (family === 4 || family === 6)
    && localAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function validateFeedUrl(input: string): URL {
  if (input.length > 2048) throw new RssError("INVALID_URL", "订阅地址过长，请检查后重试。");
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new RssError("INVALID_URL", "请输入完整的 HTTP 或 HTTPS 订阅地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new RssError("INVALID_URL", "只支持不含账号密码的 HTTP 或 HTTPS 订阅地址。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || (!isLocalFeedHost(hostname)
    && (hostname === "localhost" || /\.(localhost|local|internal)$/.test(hostname)))) {
    throw new RssError("UNSAFE_URL", "订阅地址必须是公开的网站，不能使用本地或内网地址。");
  }
  if (isIP(hostname) && !isAllowedAddress(hostname, hostname)) {
    throw new RssError("UNSAFE_URL", "订阅地址必须是公开的网站，不能使用本地或内网地址。");
  }
  url.hash = "";
  return url;
}

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;

export async function resolvePublicTarget(
  input: string,
  resolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; address: string; family: 4 | 6; hostname: string }> {
  const url = validateFeedUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Address[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolver(hostname);
  } catch {
    throw new RssError("DNS_ERROR", "无法解析订阅地址，请确认域名正确并稍后重试。", 502);
  }
  if (!addresses.length) throw new RssError("DNS_ERROR", "订阅域名没有可用的网络地址。", 502);
  // Reject mixed public/private DNS answers, rather than silently selecting the public one.
  if (addresses.some(({ address }) => !isAllowedAddress(address, hostname))) {
    throw new RssError("UNSAFE_URL", "该订阅地址指向本地、内网或保留地址，无法导入。");
  }
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return { url, hostname, address: selected.address, family: isIP(selected.address) as 4 | 6 };
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RssError("TIMEOUT", "获取订阅超时，请稍后重试。", 504));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function requestFeed(
  target: Awaited<ReturnType<typeof resolvePublicTarget>>,
  signal: AbortSignal,
  accept = "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
): Promise<{ status: number; location?: string; body: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const { url, address, family, hostname } = target;
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport({
      protocol: url.protocol,
      // Connect directly to the validated address. DNS is never resolved a second time.
      hostname: address,
      family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      servername: isIP(hostname) ? undefined : hostname,
      method: "GET",
      agent: false,
      signal,
      headers: {
        Host: url.host,
        "User-Agent": "ReadingRoom/1.0 (RSS reader)",
        Accept: accept,
        "Accept-Encoding": "identity",
      },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        resolve({ status, location: response.headers.location, body: Buffer.alloc(0) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new RssError("HTTP_ERROR", `订阅网站返回 HTTP ${status}，暂时无法读取。`, 502));
        return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy();
        reject(new RssError("NETWORK_ERROR", "订阅网站返回了不支持的压缩内容。", 502));
        return;
      }
      if (Number(response.headers["content-length"]) > MAX_FEED_BYTES) {
        response.destroy();
        reject(new RssError("TOO_LARGE", "订阅内容超过 2 MB，请使用内容较少的订阅入口。"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_FEED_BYTES) {
          response.destroy();
          reject(new RssError("TOO_LARGE", "订阅内容超过 2 MB，请使用内容较少的订阅入口。"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        status,
        body: Buffer.concat(chunks),
        contentType: response.headers["content-type"],
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function resolveWithCloudflare(hostname: string, signal: AbortSignal): Promise<Address[]> {
  // Explicit opt-in for development networks whose system DNS returns proxy Fake-IPs.
  // The resolver connection itself also uses a fixed public address and verified TLS name.
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await requestFeed({ url, address: "1.1.1.1", family: 4, hostname: url.hostname }, signal, "application/dns-json");
    const payload: unknown = JSON.parse(response.body.toString("utf8"));
    if (!payload || typeof payload !== "object") throw new Error("Invalid DNS response");
    const data = payload as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (data.Status !== 0 && data.Status !== 3) throw new Error("DNS query failed");
    return (data.Answer ?? []).flatMap((answer) => {
      if ((answer.type !== 1 && answer.type !== 28) || !answer.data || !isIP(answer.data)) return [];
      return [{ address: answer.data, family: isIP(answer.data) }];
    });
  }));
  return answers.flat();
}

export function decodeFeedBody(body: Buffer, contentType?: string): string {
  const head = body.subarray(0, 256).toString("ascii");
  const encoding = head.match(/<\?xml[^>]*encoding=["']([^"']+)/i)?.[1]
    ?? contentType?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
    ?? "utf-8";
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding, { fatal: true }); } catch {
    throw new RssError("INVALID_XML", "该订阅使用了暂不支持的文字编码。");
  }
  try { return decoder.decode(body); } catch {
    throw new RssError("INVALID_XML", "订阅内容包含损坏的文字编码，已停止本次同步，请稍后重试。", 502);
  }
}

export async function fetchFeedXml(input: string): Promise<{ xml: string; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = input;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      // Explicitly allowed local hosts need system DNS even on Fake-IP setups.
      const localHost = isLocalFeedHost(validateFeedUrl(current).hostname);
      const resolver: Resolver | undefined = process.env.RSS_DNS_MODE === "cloudflare" && !localHost
        ? (hostname) => resolveWithCloudflare(hostname, controller.signal)
        : undefined;
      const target = await awaitWithSignal(resolvePublicTarget(current, resolver), controller.signal);
      const response = await requestFeed(target, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location) throw new RssError("HTTP_ERROR", "订阅网站的跳转地址不完整。", 502);
        if (redirects === MAX_REDIRECTS) throw new RssError("TOO_MANY_REDIRECTS", "订阅地址跳转次数过多，请填写最终的订阅地址。");
        try { current = new URL(response.location, target.url).href; } catch {
          throw new RssError("INVALID_URL", "订阅网站返回了无效的跳转地址。");
        }
        // Every redirected destination passes the same URL and DNS checks.
        continue;
      }
      return { xml: decodeFeedBody(response.body, response.contentType), url: target.url.href };
    }
    throw new RssError("TOO_MANY_REDIRECTS", "订阅地址跳转次数过多。");
  } catch (error) {
    if (controller.signal.aborted) throw new RssError("TIMEOUT", "获取订阅超时，请稍后重试。", 504);
    if (error instanceof RssError) throw error;
    throw new RssError("NETWORK_ERROR", "无法连接订阅网站，请检查地址或稍后重试。", 502);
  } finally {
    clearTimeout(timer);
  }
}
