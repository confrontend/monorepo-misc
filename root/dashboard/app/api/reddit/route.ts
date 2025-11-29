// app/api/reddit/route.ts
export const runtime = "nodejs"; // ensure Node.js runtime on Vercel

import { NextResponse } from "next/server";

type Input = { urls: string[] };

type NormalizedComment = {
  id: string;
  author: string | null;
  body: string;
  score: number;
  created_utc: number;
  parent_id: string;
  depth: number;
};

type NormalizedPost = {
  id: string;
  title: string;
  subreddit: string;
  author: string | null;
  url: string;
  score: number;
  created_utc: number;
  num_comments: number;
  permalink: string;
  // content fields
  is_self: boolean;
  selftext_md: string | null;
  selftext_html: string | null;
  link_url: string | null;
  flair_text: string | null;
  media: any | null;
  is_gallery: boolean;
  gallery_data: any | null;
};

type ThreadResult = {
  sourceUrl: string;
  post: NormalizedPost;
  comments: NormalizedComment[];
};

const UA = `RedditThreadFetcher/1.0 (+contact: your-email@example.com)`;

const CID = process.env.REDDIT_CLIENT_ID!;
const CSECRET = process.env.REDDIT_CLIENT_SECRET!;

// ------------------ OAuth token (client credentials) ------------------

let cachedToken: { token: string; exp: number } | null = null;

async function getAppToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 10_000) return cachedToken.token;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials"); // app-only
  body.set("duration", "temporary");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${CID}:${CSECRET}`).toString("base64"),
    },
    body,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token fetch failed ${res.status}: ${t}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  cachedToken = {
    token: json.access_token,
    exp: Date.now() + (json.expires_in - 30) * 1000,
  };
  return cachedToken.token;
}

// ------------------ Helpers ------------------

function extractCommentsIdFromUrl(u: string) {
  // works for https://www.reddit.com/r/sub/comments/<id>/slug/
  const m = new URL(u).pathname.match(/\/comments\/([^/]+)/i);
  return m?.[1] ?? null;
}

function pickPostSource(d: any) {
  const x = d?.crosspost_parent_list?.[0];
  return x ? { ...x, permalink: d.permalink ?? x.permalink } : d;
}

function normalizeThread(json: any, sourceUrl: string): ThreadResult {
  const [postListing, commentListing] = json as [any, any];
  const raw = postListing?.data?.children?.[0]?.data;
  if (!raw) throw new Error("Unexpected Reddit JSON format for post");

  const d = pickPostSource(raw);
  const isSelf = Boolean(d.is_self);
  const linkUrl = !isSelf
    ? d.url_overridden_by_dest ?? d.url ?? null
    : null;

  const post: NormalizedPost = {
    id: d.id,
    title: d.title,
    subreddit: d.subreddit,
    author: d.author ?? null,
    url: `https://www.reddit.com${d.permalink}`,
    score: d.score ?? 0,
    created_utc: d.created_utc,
    num_comments: d.num_comments ?? 0,
    permalink: d.permalink,
    is_self: isSelf,
    selftext_md: isSelf ? d.selftext ?? null : null,
    selftext_html: isSelf ? d.selftext_html ?? null : null,
    link_url: linkUrl,
    flair_text: d.link_flair_text ?? null,
    media: d.secure_media ?? d.media ?? null,
    is_gallery: Boolean(d.is_gallery),
    gallery_data: d.gallery_data ?? null,
  };

  const out: NormalizedComment[] = [];
  const stack: Array<{ node: any; depth: number }> = [];

  for (const child of commentListing?.data?.children ?? []) {
    stack.push({ node: child, depth: 0 });
  }
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!node || node.kind !== "t1") continue; // skip "more"/others
    const c = node.data;
    out.push({
      id: c.id,
      author: c.author ?? null,
      body: c.body ?? "",
      score: c.score ?? 0,
      created_utc: c.created_utc ?? 0,
      parent_id: c.parent_id,
      depth,
    });
    const replies = c.replies?.data?.children ?? [];
    for (const r of replies) stack.push({ node: r, depth: depth + 1 });
  }

  return { sourceUrl, post, comments: out.reverse() };
}

// Prefer OAuth; fallback to public .json if needed
async function fetchThread(u: string): Promise<ThreadResult> {
  const id = extractCommentsIdFromUrl(u);
  const token = await getAppToken();

  // 1) OAuth endpoint
  {
    const oauthUrl = new URL(`https://oauth.reddit.com/comments/${id}.json`);
    oauthUrl.searchParams.set("raw_json", "1");
    const res = await fetch(oauthUrl, {
      headers: {
        "User-Agent": UA,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      return normalizeThread(data, u);
    }
    // if 401/403, fall through to public .json attempt
  }

  // 2) Public .json (may work locally; often blocked on serverless)
  {
    const alt = new URL(u);
    if (!alt.pathname.endsWith("/")) alt.pathname += "/";
    if (!alt.pathname.endsWith(".json/")) alt.pathname += ".json";
    alt.searchParams.set("raw_json", "1");
    const res = await fetch(alt, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Fetch failed (${res.status}) for ${u}`);
    }
    const data = await res.json();
    return normalizeThread(data, u);
  }
}

// ------------------ Route ------------------

export async function POST(req: Request) {
  // (optional) passkey guard — keep if you added the gate
  const PASSKEY = process.env.SITE_PASSKEY;
  if (PASSKEY) {
    const provided =
      req.headers.get("x-passkey") || new URL(req.url).searchParams.get("key");
    if (provided !== PASSKEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = (await req.json()) as Input;
  const urls = (body?.urls ?? []).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    return NextResponse.json(
      { error: "Provide { urls: string[] } with at least one URL" },
      { status: 400 }
    );
  }

  const CONCURRENCY = 4;
  const queue = [...urls];
  const results: ThreadResult[] = [];
  const errors: { url: string; error: string }[] = [];

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }).map(
    async () => {
      while (queue.length) {
        const u = queue.shift()!;
        try {
          const r = await fetchThread(u);
          results.push(r);
        } catch (e: any) {
          errors.push({ url: u, error: e?.message ?? "Unknown error" });
        }
      }
    }
  );

  await Promise.all(workers);
  return NextResponse.json({ ok: true, results, errors });
}
