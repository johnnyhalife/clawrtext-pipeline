import { Ollama } from "ollama";
import pLimit from "p-limit";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OLLAMA_URL, MODEL_REDUCE, REDUCE_CONCURRENCY, statePath } from "./config.js";
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

export async function reduceDecks(
  codename: string,
  byDeck: Map<string, ExtractedThread[]>
): Promise<void> {
  const existing = new Set(loadEntries(codename).map(e => e.deck_name));
  const pending = [...byDeck.entries()].filter(([slug]) => !existing.has(slug));

  if (pending.length === 0) {
    console.error(`[reduce] all ${byDeck.size} decks already reduced — nothing to do`);
    return;
  }

  console.error(`[reduce] reducing ${pending.length} new decks via ${MODEL_REDUCE} (concurrency=${REDUCE_CONCURRENCY})`);

  const limit = pLimit(REDUCE_CONCURRENCY);

  await Promise.all(
    pending.map(([deckSlug, slides]) =>
      limit(async () => {
        // Recover original filename from topic: "2024-12-17 - Sprint 1 Review.pptx – Slide 3"
        const deckFilename = slides[0]?.topic?.replace(/ – Slide \d+$/, "").trim() ?? deckSlug;
        console.error(`[reduce] → ${deckFilename} (${slides.length} slides)`);

        const narrative = await reduceSingleDeck(deckFilename, slides);

        const entry: DeckEntry = {
          deck_name: deckSlug,
          deck_filename: deckFilename,
          deck_date: deckDateFromName(deckSlug),
          slide_count: slides.length,
          narrative,
          reduced_at: new Date().toISOString(),
        };

        appendEntry(codename, entry);       // persist to .entries JSONL cache
        appendEntryToPage(codename, entry);   // append to project .md immediately
        console.error(`[reduce] ✓ ${deckFilename}`);
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
