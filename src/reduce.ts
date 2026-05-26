import { Ollama } from "ollama";
import pLimit from "p-limit";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OLLAMA_URL, MODEL_REDUCE, REDUCE_CONCURRENCY, statePath } from "./config.js";
import type { ExtractedThread } from "./types.js";
import { renderPrompt } from "./prompts.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeckEntry {
  deck_name: string;
  deck_date: string;       // YYYY-MM-DD derived from deck filename
  slide_count: number;
  narrative: string;
  reduced_at: string;
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

// ── Main export ───────────────────────────────────────────────────────────────

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

  // Group slides by deck_name (uid format: deck:{codename}:{deckSlug}:slide{N})
  const byDeck = new Map<string, ExtractedThread[]>();
  for (const slide of allSlides) {
    // uid: deck:eulophia:2025-07-14-iteration-1:slide3
    const parts = slide.uid.split(":");
    const deckSlug = parts[2] ?? "unknown";
    if (!byDeck.has(deckSlug)) byDeck.set(deckSlug, []);
    byDeck.get(deckSlug)!.push(slide);
  }

  // Load existing entries to skip already-reduced decks
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
        // Reconstruct a readable deck name from slug
        const deckName = deckSlug.replace(/-/g, " ").replace(/(\d{4}) (\d{2}) (\d{2})/, "$1-$2-$3");
        console.error(`[reduce] → ${deckName} (${slides.length} slides)`);

        const narrative = await reduceSingleDeck(deckName, slides);

        const entry: DeckEntry = {
          deck_name: deckSlug,
          deck_date: deckDateFromName(deckSlug),
          slide_count: slides.length,
          narrative,
          reduced_at: new Date().toISOString(),
        };

        appendEntry(codename, entry);
        console.error(`[reduce] ✓ ${deckName}`);
      })
    )
  );

  const total = loadEntries(codename).length;
  console.error(`[reduce] done — ${total} total deck entries for ${codename}`);
}
