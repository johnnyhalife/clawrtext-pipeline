import { Ollama } from "ollama";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OLLAMA_URL, MODEL_COMPILED_TRUTH, statePath, projectPath } from "./config.js";
import { renderPrompt } from "./prompts.js";
import type { DeckEntry } from "./reduce.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadEntries(codename: string): DeckEntry[] {
  const p = statePath(codename, "entries.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as DeckEntry)
    .sort((a, b) => a.deck_date.localeCompare(b.deck_date));
}

// Format: "### *Dec 17, 2024* - Extracted from `2024-12-17 - Sprint 1 Review.pptx` - (6 Slides)"
function formatEntryHeader(entry: DeckEntry): string {
  const d = new Date(entry.reduced_at);
  const humanDate = d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires",
  });
  return `### *${humanDate} GMT-3* - Extracted from \`${entry.deck_filename}\` - (${entry.slide_count} Slides)`;
}

function parseIdentityBlock(md: string): string {
  const m = md.match(/## Identity\n([\s\S]*?)(?=\n##|\n---|$)/);
  return m ? m[1].trim() : [
    "- **Customer:** <!-- reconcile -->",
    "- **Period:** <!-- reconcile -->",
    "- **Engagement lead:** <!-- reconcile -->",
    "- **Customer representative:** <!-- reconcile -->",
    "- **Stack:** <!-- reconcile -->",
  ].join("\n");
}

function parseCompiledTruth(md: string): string {
  const m = md.match(/## Compiled Truth\n([\s\S]*?)(?=\n---|$)/);
  return m ? m[1].trim() : "";
}

// ── Project page renderer ─────────────────────────────────────────────────────

function renderPage(codename: string, identity: string, compiledTruth: string, entries: DeckEntry[]): string {
  const entryBlocks = entries
    .map(e => `${formatEntryHeader(e)}\n${e.narrative}`)
    .join("\n\n");

  return `# ${codename}
## Identity
${identity}

## Compiled Truth
${compiledTruth}

---

${entryBlocks}
`;
}

// ── Append a single entry to the project page (called by reduce as each deck finishes) ──

export function appendEntryToPage(codename: string, entry: DeckEntry): void {
  const projPath = projectPath(codename);
  mkdirSync(dirname(projPath), { recursive: true });

  if (!existsSync(projPath)) {
    // First entry — create the file with identity stub and separator
    const page = `# ${codename}
## Identity
- **Customer:** <!-- reconcile -->
- **Period:** <!-- reconcile -->
- **Engagement lead:** <!-- reconcile -->
- **Customer representative:** <!-- reconcile -->
- **Stack:** <!-- reconcile -->

## Compiled Truth
<!-- will be generated after all decks reduce -->

---

${formatEntryHeader(entry)}
${entry.narrative}
`;
    writeFileSync(projPath, page, "utf-8");
    console.error(`[project-page] created ${projPath}`);
    return;
  }

  // Append below the --- separator
  const existing = readFileSync(projPath, "utf-8");
  const header = formatEntryHeader(entry);
  const block = `\n${header}\n${entry.narrative}\n`;
  writeFileSync(projPath, existing + block, "utf-8");
  console.error(`[project-page] appended entry for ${entry.deck_filename}`);
}

// ── Regenerate compiled truth from all entries (called after all decks reduce) ──

export async function updateCompiledTruth(codename: string): Promise<void> {
  const entries = loadEntries(codename);
  if (entries.length === 0) {
    console.error(`[compiled-truth] no deck entries found — run reduce phase first`);
    process.exit(1);
  }

  const projPath = projectPath(codename);
  const existingMd = existsSync(projPath) ? readFileSync(projPath, "utf-8") : "";
  const identity = parseIdentityBlock(existingMd);

  console.error(`[compiled-truth] synthesizing from ${entries.length} deck entries via ${MODEL_COMPILED_TRUTH}`);

  const entriesText = entries
    .map(e => `[${e.deck_date}] ${e.narrative}`)
    .join("\n\n");

  const systemPrompt = renderPrompt("synthesize", "system", {});
  const userPrompt = renderPrompt("synthesize", "user", {
    codename,
    existingNarrative: parseCompiledTruth(existingMd) || null,
    newEntries: entriesText,
  });

  const response = await ollama.chat({
    model: MODEL_COMPILED_TRUTH,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    options: { temperature: 0.2 },
  });

  const compiledTruth = response.message.content.trim();
  const page = renderPage(codename, identity, compiledTruth, entries);

  mkdirSync(dirname(projPath), { recursive: true });
  writeFileSync(projPath, page, "utf-8");
  console.error(`[compiled-truth] ✓ wrote ${projPath}`);
}
