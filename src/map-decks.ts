import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Ollama } from "ollama";
import pLimit from "p-limit";

import {
  OLLAMA_URL,
  // CLAWRTEX_ROOT no longer needed in map-decks (path comes from thread.image_path)
  MODEL_MAP_DECKS,
  MAP_CONCURRENCY,
  statePath,
} from "./config.js";
import { ExtractedThreadSchema, type Thread, type ExtractedThread } from "./types.js";
import { renderPrompt } from "./prompts.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Cache ──────────────────────────────────────────────────────────

function threadHash(thread: Thread): string {
  const body = thread.posts[0].body; // MD5 hex for deck slides
  return createHash("sha256").update(thread.uid + "\n" + body).digest("hex").slice(0, 16);
}

function loadCache(codename: string): Map<string, ExtractedThread> {
  const p = statePath(codename, "extracted.jsonl");
  if (!existsSync(p)) return new Map();
  const cache = new Map<string, ExtractedThread>();
  for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line) as ExtractedThread & { _hash?: string };
      if (rec._hash) cache.set(rec._hash, rec);
    } catch { /* skip */ }
  }
  return cache;
}

// ── Image path from UID ──────────────────────────────────────────

function resolveImagePath(thread: Thread): string | null {
  // Prefer the absolute path recorded by ingest-decks
  if (thread.image_path) {
    if (existsSync(thread.image_path)) return thread.image_path;
    console.error(`[map-decks] ERROR image_path recorded but file missing: ${thread.image_path}`);
    return null;
  }
  // Fallback: threads ingested before image_path was added — fail loudly
  console.error(`[map-decks] ERROR no image_path on thread ${thread.uid} — re-run ingest to populate it`);
  return null;
}

// ── Prompt ─────────────────────────────────────────────────────────

function buildPrompt(thread: Thread): string {
  const slide = thread.posts[0];
  const deckName = thread.topic.replace(/ – Slide \d+$/, "");
  return renderPrompt("map-decks", "user", {
    deckName,
    slideTopic: thread.topic,
    slideDate: slide.received.slice(0, 10),
  });
}

// ── Extract one slide-thread ───────────────────────────────────────

async function extractSlide(thread: Thread): Promise<ExtractedThread> {
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  const imagePath = resolveImagePath(thread);
  if (!imagePath) {
    console.error(`[map-decks] WARN no image found for ${thread.uid} — slide will be text-only`);
  }
  const imageData = imagePath
    ? readFileSync(imagePath).toString("base64")
    : null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ollama.chat({
        model: MODEL_MAP_DECKS,
        think: false,
        messages: [
          { role: "system", content: renderPrompt("map-decks", "system") },
          { role: "user", content: buildPrompt(thread), images: imageData ? [imageData] : undefined },
        ],
        options: { temperature: 0.1 },
      });

      const raw = response.message.content.trim();
      const json = raw.startsWith("```")
        ? raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim()
        : raw;

      // Strip thinking tags if model leaks them
      const stripped = json.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const finalJson = stripped.startsWith("{") ? stripped : stripped.slice(stripped.indexOf("{"));

      const parsed = JSON.parse(finalJson) as unknown;
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
        console.error(`[map-decks] retry ${attempt + 1} for ${thread.uid}: ${lastError.message}`);
      }
    }
  }

  console.error(`[map-decks] SKIP ${thread.uid} after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  return {
    uid: thread.uid,
    codename: thread.codename,
    topic: thread.topic,
    summary: "(extraction failed)",
    decisions: [],
    action_items: [],
    sentiment: "neutral",
    has_external: true,
  };
}

// ── Main ────────────────────────────────────────────────────────────

export async function mapDecks(codename: string, deckFilter?: string): Promise<ExtractedThread[]> {
  const threadsPath = statePath(codename, "threads.jsonl");
  if (!existsSync(threadsPath)) {
    throw new Error(`threads.jsonl not found — run ingest-decks first: ${threadsPath}`);
  }

  const threads: Thread[] = readFileSync(threadsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Thread)
    .filter(t => t.uid.startsWith("deck:")) // only deck-sourced threads
    .filter(t => {
      if (!deckFilter) return true;
      // uid: deck:<codename>:<slugDeck>:slide<N> — match slug derived from deck filename
      const slug = deckFilter.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      return t.uid.split(":")[2] === slug;
    });

  if (deckFilter) {
    console.error(`[map-decks] single-deck mode: ${threads.length} slides from "${deckFilter}"`);
  } else {
    console.error(`[map-decks] ${threads.length} slide-threads to process using ${MODEL_MAP_DECKS}`);
  }

  const cache = loadCache(codename);
  console.error(`[map-decks] cache: ${cache.size} already extracted`);

  const outPath = statePath(codename, "extracted.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });

  const results: ExtractedThread[] = [];
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

  console.error(`[map-decks] ${toProcess.length} slides need extraction, ${threads.length - toProcess.length} cached`);

  if (toProcess.length === 0) {
    console.error(`[map-decks] all slides cached — nothing to do`);
    return results;
  }

  let done = 0;
  const limit = pLimit(MAP_CONCURRENCY);

  const newResults = await Promise.all(
    toProcess.map(thread =>
      limit(async () => {
        const hash = threadHash(thread);
        const extracted = await extractSlide(thread);
        // Passthrough fields — not extracted by LLM
        if (thread.deck_filename) extracted.deck_filename = thread.deck_filename;
        if (thread.source_url)    extracted.source_url    = thread.source_url;
        if (thread.last_delivered) extracted.deck_date    = thread.last_delivered.slice(0, 10);
        const slideIndex = thread.uid.match(/:slide(\d+)$/)?.[1];
        if (slideIndex) extracted.slide_index = Number(slideIndex);
        done++;
        if (done % 10 === 0 || done === toProcess.length) {
          console.error(`[map-decks] ${done}/${toProcess.length} extracted`);
        }
        appendFileSync(outPath, JSON.stringify({ ...extracted, _hash: hash }) + "\n", "utf-8");
        return extracted;
      })
    )
  );

  results.push(...newResults);
  console.error(`[map-decks] wrote ${results.length} total records → ${outPath}`);
  return results;
}
