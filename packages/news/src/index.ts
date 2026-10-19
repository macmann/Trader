import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
export const feeds = [
  {
    source: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss",
  },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
] as const;
export type Article = {
  id: string;
  source: string;
  title: string;
  url: string;
  publishedAt: Date;
};
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (k.startsWith("utm_") || ["ref", "fbclid", "gclid"].includes(k))
        u.searchParams.delete(k);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return null;
  }
}
export function parseFeed(
  xml: string,
  source: string,
  now = Date.now(),
): Article[] {
  if (xml.length > 1000000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw Error("NEWS_FEED_INVALID");
  const parser = new XMLParser({
    ignoreAttributes: true,
    processEntities: false,
    parseTagValue: false,
  });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  const list = Array.isArray(items) ? items : [items];
  const output: Article[] = [];
  for (const item of list.slice(0, 50)) {
    if (typeof item.title !== "string" || typeof item.link !== "string")
      continue;
    const title = item.title
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400),
      url = normalizeUrl(item.link),
      publishedAt = new Date(item.pubDate ?? item.published ?? item.updated);
    if (
      !title ||
      !url ||
      !Number.isFinite(publishedAt.getTime()) ||
      publishedAt.getTime() > now + 300000 ||
      now - publishedAt.getTime() > 7 * 86400000
    )
      continue;
    output.push({
      id: createHash("sha256").update(url).digest("hex"),
      source,
      title,
      url,
      publishedAt,
    });
  }
  return [...new Map(output.map((a) => [a.id, a])).values()];
}
export async function fetchFeed(
  feed: (typeof feeds)[number],
  transport: typeof fetch = fetch,
): Promise<Article[]> {
  const response = await transport(feed.url, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!response.ok) throw Error("NEWS_FEED_UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw Error("NEWS_FEED_INVALID");
  let total = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1000000) throw Error("NEWS_FEED_TOO_LARGE");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return parseFeed(Buffer.concat(parts).toString("utf8"), feed.source);
}
