import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Ollama } from "ollama";
import pLimit from "p-limit";

import {
  OLLAMA_URL,
  CLAWRTEX_ROOT,
  MODEL_MAP_DECKS,
  MAP_CONCURRENCY,
  statePath,
} from "./config.js";
import { ExtractedThreadSchema, type Thread, type ExtractedThread } from "./types.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Cache ─────────────────────────────────────────────────────────────────────

function threadHash(thread: Thread): string {
  const content = thread.uid + "\n" + thread.posts.map(p => p.body).join("\n");
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
    } catch { /* skip */ }
  }
  return cache;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(thread: Thread): string {
  const slide = thread.posts[0];
  const deckName = thread.topic.replace(/ – Slide \d+$/, "");

  return `You are extracting structured metadata from a single slide of a software project iteration review deck.

Deck: ${deckName}
Slide: ${thread.topic}
Date: ${slide.received.slice(0, 10)}

Slide content:
${slide.body.slice(0, 3000)}

You are reading a slide from a customer-facing iteration review. These decks show what was built and delivered each sprint.

For this slide, answer:
1. WHAT was built, delivered, or demonstrated? (the feature, component, milestone, or artifact shown on this slide)
2. WHY does it matter? (the problem solved, the goal achieved, the customer outcome — only if stated on the slide)
3. HOW was it implemented or approached? (architecture, technology, method — only if stated on the slide)

If the slide is a title slide, agenda, table of contents, or team introduction with no engineering substance — return a one-sentence summary and empty arrays.

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "topic": "<concise topic label, max 10 words>",
  "summary": "<2-4 sentences answering what/why/how — factual, no spin, only what the slide states>",
  "decisions": ["<specific decision or design choice visible on this slide>", ...],
  "action_items": ["<concrete next step or commitment stated on this slide>", ...],
  "sentiment": "<positive|neutral|negative|mixed>",
  "has_external": true
}

Rules:
- has_external is always true for deck slides (they are customer-facing by definition)
- summary must be factual — only what the slide explicitly states, no inferred rationale
- do NOT add generic phrases like "to meet client requirements", "to ensure scalability" — only state what is on the slide
- decisions and action_items must be directly visible on the slide — do not invent or generalize
- if the slide is a cover/title/agenda slide: one-sentence summary, empty arrays
- topic must be specific to this slide's content, not just the deck name`;
}

// ── Extract one slide-thread ──────────────────────────────────────────────────

async function extractSlide(thread: Thread): Promise<ExtractedThread> {
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ollama.chat({
        model: MODEL_MAP_DECKS,
        messages: [
          {
            role: "system",
            content: "You are a structured data extractor reading iteration review slides. Output ONLY valid JSON. No preamble, no explanation, no markdown, no thinking tags. Your entire response must be a single JSON object.",
          },
          { role: "user", content: buildPrompt(thread) },
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

// ── Main ──────────────────────────────────────────────────────────────────────

export async function mapDecks(codename: string): Promise<ExtractedThread[]> {
  const threadsPath = statePath(codename, "threads.jsonl");
  if (!existsSync(threadsPath)) {
    throw new Error(`threads.jsonl not found — run ingest-decks first: ${threadsPath}`);
  }

  const threads: Thread[] = readFileSync(threadsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Thread)
    .filter(t => t.uid.startsWith("deck:")); // only deck-sourced threads

  console.error(`[map-decks] ${threads.length} slide-threads to process using ${MODEL_MAP_DECKS}`);

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

  if (cache.size > 0) {
    writeFileSync(outPath, results.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  }

  let done = 0;
  const limit = pLimit(MAP_CONCURRENCY);

  const newResults = await Promise.all(
    toProcess.map(thread =>
      limit(async () => {
        const hash = threadHash(thread);
        const extracted = await extractSlide(thread);
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
