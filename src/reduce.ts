import { Ollama } from "ollama";
import pLimit from "p-limit";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OLLAMA_URL, MODEL_REDUCE, REDUCE_CONCURRENCY, statePath } from "./config.js";
import { db } from "./db.js";
import type { ExtractedThread } from "./types.js";
import { renderPrompt } from "./prompts.js";
import { appendEntryToPage } from "./synthesize.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeckEntry {
  deck_name: string;       // slug derived from filename
  deck_filename: string;   // original filename e.g. "2024-12-17 - Sprint 1 Review.pptx"
  deck_date: string;       // YYYY-MM-DD derived from deck filename
  slide_count: number;
  narrative: string;
  reduced_at: string;      // ISO 8601 — when this entry was written
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deckDateFromName(deckName: string): string {
  // "2025-07-14 - Iteration 1" → "2025-07-14"
  const m = deckName.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "unknown";
}

function loadEntries(codename: string): DeckEntry[] {
  const p = statePath(codename, "entries.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as DeckEntry);
}

function appendEntry(codename: string, entry: DeckEntry): void {
  const p = statePath(codename, "entries.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entry) + "\n", { flag: "a" });
}

// ── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  delays = [30_000, 60_000, 90_000]
): Promise<T | null> {
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === delays.length) {
        console.error(`[reduce] ✗ ${label} — failed after ${attempt + 1} attempts, skipping: ${err}`);
        return null;
      }
      const wait = delays[attempt];
      console.error(`[reduce] ⚠ ${label} — attempt ${attempt + 1} failed, retrying in ${wait / 1000}s: ${err}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return null;
}

// ── Per-deck reduce ───────────────────────────────────────────────────────────

async function reduceSingleDeck(
  deckName: string,
  slides: ExtractedThread[]
): Promise<string> {
  const summaries = slides
    .filter(s => s.summary && s.summary.trim().length > 0)
    .map(s => {
      const parts = [`[${s.topic}] ${s.summary}`];
      if (s.decisions?.length) parts.push(`  Decisions: ${s.decisions.join("; ")}`);
      return parts.join("\n");
    })
    .join("\n");

  const prompt = renderPrompt("reduce", "user", { deckName, summaries });

  const response = await ollama.chat({
    model: MODEL_REDUCE,
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.2 },
  });

  return response.message.content.trim();
}

// ── Group slides by deck ─────────────────────────────────────────────────────

export function groupByDeck(slides: ExtractedThread[]): Map<string, ExtractedThread[]> {
  const byDeck = new Map<string, ExtractedThread[]>();
  for (const slide of slides) {
    // uid: deck:{codename}:{deckSlug}:slide{N}
    const parts = slide.uid.split(":");
    const deckSlug = parts[2] ?? "unknown";
    if (!byDeck.has(deckSlug)) byDeck.set(deckSlug, []);
    byDeck.get(deckSlug)!.push(slide);
  }
  return byDeck;
}

// ── Core reduce runner (accepts pre-grouped slides) ───────────────────────────

// ── PG: load already-processed (codename, deck_name, deck_hash, model) triples ──

async function loadProcessedFromPG(codename: string): Promise<Set<string>> {
  try {
    const { rows } = await db().query<{ deck_name: string; deck_hash: string; model: string }>(
      `SELECT deck_name, deck_hash, model FROM evidence_trail WHERE codename = $1`,
      [codename]
    );
    // Key: deck_name:deck_hash:model — noop only if all three match
    return new Set(rows.map(r => `${r.deck_name}:${r.deck_hash ?? ""}:${r.model ?? ""}`));
  } catch {
    console.error(`[reduce] could not load evidence_trail from PG — falling back to JSONL cache`);
    return new Set();
  }
}

async function upsertEvidenceTrail(codename: string, entry: DeckEntry, deckHash: string): Promise<void> {
  await db().query(
    `INSERT INTO evidence_trail
       (codename, source, deck_name, deck_date, model, slide_count, deck_hash, run_at)
     VALUES ($1, 'decks', $2, $3, $4, $5, $6, now())
     ON CONFLICT (codename, deck_name, deck_hash, model) DO NOTHING`,
    [
      codename,
      entry.deck_name,
      entry.deck_date === "unknown" ? null : entry.deck_date,
      MODEL_REDUCE,
      entry.slide_count,
      deckHash,
    ]
  );
}

export async function reduceDecks(
  codename: string,
  byDeck: Map<string, ExtractedThread[]>,
  deckHashes: Map<string, string> = new Map()
): Promise<void> {
  const existing = new Set(loadEntries(codename).map(e => e.deck_name));
  const pgProcessed = await loadProcessedFromPG(codename);
  // Noop if: in JSONL cache AND (in PG with same hash+model OR no hash available)
  const pending = [...byDeck.entries()].filter(([slug]) => {
    if (!existing.has(slug)) return true;   // not in JSONL cache → must run
    const hash = deckHashes.get(slug) ?? "";
    const pgKey = `${slug}:${hash}:${MODEL_REDUCE}`;
    if (hash && pgProcessed.has(pgKey)) return false;  // PG says noop
    return false;  // in JSONL, no hash info → treat as done
  });

  if (pending.length === 0) {
    console.error(`[reduce] all ${byDeck.size} decks already reduced — nothing to do`);
    return;
  }

  console.error(`[reduce] reducing ${pending.length} new decks via ${MODEL_REDUCE} (concurrency=${REDUCE_CONCURRENCY})`);

  const limit = pLimit(REDUCE_CONCURRENCY);

  await Promise.all(
    pending.map(([deckSlug, slides]) =>
      limit(async () => {
        // Use original filename stored at ingest time — never rely on LLM-generated topic
        const deckFilename = slides[0]?.deck_filename ?? deckSlug;
        console.error(`[reduce] → ${deckFilename} (${slides.length} slides)`);

        const narrative = await withRetry(
          deckFilename,
          () => reduceSingleDeck(deckFilename, slides)
        );
        if (narrative === null) return; // logged + skipped

        const entry: DeckEntry = {
          deck_name: deckSlug,
          deck_filename: deckFilename,
          deck_date: deckDateFromName(deckSlug),
          slide_count: slides.length,
          narrative,
          reduced_at: new Date().toISOString(),
        };

        appendEntry(codename, entry);        // persist to .entries JSONL cache
        appendEntryToPage(codename, entry);   // append to project .md immediately

        // Write to PG evidence_trail
        const deckHash = deckHashes.get(deckSlug) ?? "";
        try {
          await upsertEvidenceTrail(codename, entry, deckHash);
          console.error(`[reduce] ✓ ${deckFilename} (evidence_trail written)`);
        } catch (err) {
          console.error(`[reduce] ⚠ ${deckFilename} — evidence_trail write failed: ${err}`);
        }
      })
    )
  );

  const total = loadEntries(codename).length;
  console.error(`[reduce] done — ${total} total deck entries for ${codename}`);
}

// ── Standalone phase (reads from .extraction cache) ───────────────────────────

export async function reduceDeck(codename: string): Promise<void> {
  const extractedPath = statePath(codename, "extracted.jsonl");
  if (!existsSync(extractedPath)) {
    console.error(`[reduce] no extraction found at ${extractedPath} — run map phase first`);
    process.exit(1);
  }

  const allSlides: ExtractedThread[] = readFileSync(extractedPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as ExtractedThread);

  await reduceDecks(codename, groupByDeck(allSlides));
}
