import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from "fs";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import pLimit from "p-limit";

import {
  CLAWRTEX_ROOT,
  credentials,
  GRAPH_CONCURRENCY,
  statePath,
} from "./config.js";
import type { Thread, Post, DeltaState } from "./types.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const url = `https://login.microsoftonline.com/${credentials.tenant_id}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`Auth failed: ${data.error_description ?? JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── Group resolve ─────────────────────────────────────────────────────────────

async function resolveGroup(token: string, dlAddress: string): Promise<string> {
  const url = `https://graph.microsoft.com/v1.0/groups?$search="mail:${dlAddress}"&$select=id,displayName,mail`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ConsistencyLevel: "eventual",
    },
  });

  const data = await res.json() as { value?: Array<{ id: string; displayName: string }> };
  const group = data.value?.[0];
  if (!group?.id) {
    throw new Error(`DL not found: ${dlAddress} — check the address and try again.`);
  }

  console.error(`Group: ${group.displayName} (${group.id})`);
  return group.id;
}

// ── Thread list (paginated, delta-aware) ──────────────────────────────────────

interface RawThread {
  id: string;
  topic: string;
  lastDeliveredDateTime: string;
  uniqueSenders: string[];
}

async function fetchAllThreads(
  token: string,
  groupId: string,
  since: string | null
): Promise<RawThread[]> {
  const all: RawThread[] = [];
  let url: string | null =
    `https://graph.microsoft.com/v1.0/groups/${groupId}/threads` +
    `?$top=50&$select=id,topic,lastDeliveredDateTime,uniqueSenders`;

  let page = 1;
  while (url) {
    console.error(`Fetching thread page ${page}...`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as {
      value?: RawThread[];
      "@odata.nextLink"?: string;
    };

    let threads = data.value ?? [];

    // Client-side delta filter — Graph threads API doesn't support $filter on lastDeliveredDateTime
    if (since) {
      threads = threads.filter(t => t.lastDeliveredDateTime >= since);
    }

    all.push(...threads);
    url = data["@odata.nextLink"] ?? null;
    page++;
  }

  return all;
}

// ── Post fetch ────────────────────────────────────────────────────────────────

interface RawPost {
  sender: { emailAddress: { address: string } };
  receivedDateTime: string;
  body: { content: string; contentType: string };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPosts(
  token: string,
  groupId: string,
  thread: RawThread
): Promise<Post[]> {
  const url =
    `https://graph.microsoft.com/v1.0/groups/${groupId}/threads/${thread.id}/posts` +
    `?$select=sender,receivedDateTime,body`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as { value?: RawPost[] };

  return (data.value ?? []).map(p => {
    const sender = p.sender?.emailAddress?.address ?? "";
    const body = p.body?.contentType === "html"
      ? stripHtml(p.body.content)
      : (p.body?.content ?? "");
    return {
      sender,
      received: p.receivedDateTime,
      is_external: !sender.toLowerCase().endsWith("@southworks.com"),
      body,
    };
  });
}

// ── Delta state ───────────────────────────────────────────────────────────────

function loadDeltaState(codename: string): DeltaState | null {
  const p = resolve(CLAWRTEX_ROOT, "state", `${codename}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as DeltaState;
}

function saveDeltaState(
  codename: string,
  dl: string,
  count: number,
  earliest: string | null,
  latest: string | null
): void {
  const p = resolve(CLAWRTEX_ROOT, "state", `${codename}.json`);
  // Preserve earliest from a prior run if this is a delta (new earliest can only go backward)
  const existing = loadDeltaState(codename);
  const resolvedEarliest = earliest && existing?.earliest
    ? (earliest < existing.earliest ? earliest : existing.earliest)
    : (earliest ?? existing?.earliest ?? null);
  const resolvedLatest = latest && existing?.latest
    ? (latest > existing.latest ? latest : existing.latest)
    : (latest ?? existing?.latest ?? null);

  const state: DeltaState = {
    dl,
    codename,
    last_fetched: new Date().toISOString(),
    last_count: count,
    earliest: resolvedEarliest,
    latest: resolvedLatest,
  };
  writeFileSync(p, JSON.stringify(state, null, 2));
}

// ── JSONL writer ──────────────────────────────────────────────────────────────

function writeThreadsJsonl(codename: string, threads: Thread[]): string {
  const outPath = statePath(codename, "threads.jsonl");
  mkdirSync(resolve(CLAWRTEX_ROOT, "state"), { recursive: true });
  const lines = threads.map(t => JSON.stringify(t)).join("\n");
  writeFileSync(outPath, lines + "\n", "utf-8");
  return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function ingest(codename: string, dlAddress: string): Promise<Thread[]> {
  console.error(`[ingest] codename=${codename} dl=${dlAddress}`);

  // Delta state
  const state = loadDeltaState(codename);
  const since = state?.last_fetched ?? null;
  if (since) {
    console.error(`[ingest] delta mode: fetching since ${since}`);
  } else {
    console.error(`[ingest] full fetch (no prior state)`);
  }

  // Auth
  console.error(`[ingest] authenticating...`);
  const token = await getAccessToken();
  console.error(`[ingest] auth OK`);

  // Resolve group
  const groupId = await resolveGroup(token, dlAddress);

  // Fetch thread list
  const rawThreads = await fetchAllThreads(token, groupId, since);
  console.error(`[ingest] ${rawThreads.length} threads to process`);

  // Fetch posts concurrently
  const limit = pLimit(GRAPH_CONCURRENCY);
  const threads: Thread[] = await Promise.all(
    rawThreads.map(raw =>
      limit(async () => {
        const posts = await fetchPosts(token, groupId, raw);
        const hasExternal = posts.some(p => p.is_external);
        const uid = `email:${raw.id}`;
        return {
          uid,
          codename,
          topic: raw.topic,
          last_delivered: raw.lastDeliveredDateTime,
          is_external: hasExternal,
          posts,
        } satisfies Thread;
      })
    )
  );

  // Compute date bounds across all posts
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const thread of threads) {
    for (const post of thread.posts) {
      if (!earliest || post.received < earliest) earliest = post.received;
      if (!latest || post.received > latest) latest = post.received;
    }
  }
  console.error(`[ingest] date bounds: ${earliest?.slice(0, 10) ?? "none"} → ${latest?.slice(0, 10) ?? "none"}`);

  // Write JSONL
  const outPath = writeThreadsJsonl(codename, threads);
  console.error(`[ingest] wrote ${threads.length} threads → ${outPath}`);

  // Update delta state
  saveDeltaState(codename, dlAddress, threads.length, earliest, latest);
  console.error(`[ingest] delta state updated`);

  return threads;
}
