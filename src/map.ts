import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { Ollama } from "ollama";
import pLimit from "p-limit";

import {
  OLLAMA_URL,
  CLAWRTEX_ROOT,
  MODEL_MAP,
  MAP_CONCURRENCY,
  statePath,
} from "./config.js";
import { ExtractedThreadSchema, type Thread, type ExtractedThread } from "./types.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Cache ─────────────────────────────────────────────────────────────────────

function threadHash(thread: Thread): string {
  const content = thread.posts.map(p => p.body).join("\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function loadCache(codename: string): Map<string, ExtractedThread> {
  const p = statePath(codename, "extracted.jsonl");
  if (!existsSync(p)) return new Map();
  const cache = new Map<string, ExtractedThread>();
  for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line) as ExtractedThread & { _hash?: string };
      if (rec._hash) cache.set(rec._hash, rec);
    } catch { /* skip malformed */ }
  }
  return cache;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(thread: Thread): string {
  const posts = thread.posts
    .map(p => `[${p.received.slice(0, 10)} | ${p.sender}]\n${p.body.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  return `You are extracting structured metadata from an internal project email thread.

Thread topic: ${thread.topic}
Last activity: ${thread.last_delivered.slice(0, 10)}
Has external participants: ${thread.is_external}

Posts:
${posts}

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "topic": "<concise topic label, max 10 words>",
  "summary": "<2-4 sentence factual summary of what happened in this thread>",
  "decisions": ["<decision made>", ...],
  "action_items": ["<action item>", ...],
  "sentiment": "<positive|neutral|negative|mixed>",
  "has_external": <true|false>
}

Rules:
- decisions and action_items may be empty arrays if none exist
- summary must be factual, no adjectives, no spin
- sentiment reflects the tone of the thread, not the project
- has_external must match whether any non-@southworks.com sender appears`;
}

// ── Extract one thread ────────────────────────────────────────────────────────

async function extractThread(thread: Thread): Promise<ExtractedThread> {
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ollama.chat({
        model: MODEL_MAP,
        messages: [{ role: "user", content: buildPrompt(thread) }],
        options: { temperature: 0.1 },
      });

      const raw = response.message.content.trim();

      // Strip markdown code fences if model wraps output
      const json = raw.startsWith("```")
        ? raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim()
        : raw;

      const parsed = JSON.parse(json) as unknown;
      const result = ExtractedThreadSchema.safeParse({
        uid: thread.uid,
        codename: thread.codename,
        ...parsed as object,
      });

      if (!result.success) {
        throw new Error(`Zod validation failed: ${result.error.message}`);
      }

      return result.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        console.error(`[map] retry ${attempt + 1} for ${thread.uid}: ${lastError.message}`);
      }
    }
  }

  // Fallback: minimal record so pipeline can continue
  console.error(`[map] SKIP ${thread.uid} after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  return {
    uid: thread.uid,
    codename: thread.codename,
    topic: thread.topic,
    summary: "(extraction failed)",
    decisions: [],
    action_items: [],
    sentiment: "neutral",
    has_external: thread.is_external,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function map(codename: string): Promise<ExtractedThread[]> {
  const threadsPath = statePath(codename, "threads.jsonl");
  if (!existsSync(threadsPath)) {
    throw new Error(`threads.jsonl not found — run ingest first: ${threadsPath}`);
  }

  const threads: Thread[] = readFileSync(threadsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Thread);

  console.error(`[map] ${threads.length} threads to process`);

  // Load cache
  const cache = loadCache(codename);
  console.error(`[map] cache: ${cache.size} already extracted`);

  const outPath = statePath(codename, "extracted.jsonl");
  mkdirSync(resolve(CLAWRTEX_ROOT, "state"), { recursive: true });

  // Open append stream — write incrementally so partial runs are recoverable
  const results: ExtractedThread[] = [];

  // Separate cached vs new
  const toProcess: Thread[] = [];
  for (const thread of threads) {
    const hash = threadHash(thread);
    const cached = cache.get(hash);
    if (cached) {
      results.push(cached);
    } else {
      toProcess.push(thread);
    }
  }

  console.error(`[map] ${toProcess.length} threads need extraction, ${threads.length - toProcess.length} cached`);

  if (toProcess.length === 0) {
    console.error(`[map] all threads cached — nothing to do`);
    return results;
  }

  // Seed outPath with already-cached records so wc -l reflects total from the start
  if (cache.size > 0 && !existsSync(outPath)) {
    writeFileSync(
      outPath,
      Array.from(cache.values()).map(r => JSON.stringify(r)).join("\n") + "\n",
      "utf-8"
    );
  }

  let done = 0;
  const limit = pLimit(MAP_CONCURRENCY);

  const newResults = await Promise.all(
    toProcess.map(thread =>
      limit(async () => {
        const hash = threadHash(thread);
        const extracted = await extractThread(thread);
        done++;
        if (done % 10 === 0 || done === toProcess.length) {
          console.error(`[map] ${done}/${toProcess.length} extracted`);
        }
        // Append incrementally — visible via wc -l as each thread completes
        appendFileSync(outPath, JSON.stringify({ ...extracted, _hash: hash }) + "\n", "utf-8");
        return extracted;
      })
    )
  );

  results.push(...newResults);
  console.error(`[map] wrote ${results.length} total records → ${outPath}`);
  return results;
}
