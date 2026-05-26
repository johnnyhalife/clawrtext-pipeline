import { Ollama } from "ollama";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";  // readFileSync used for existing project page
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
    .map(l => JSON.parse(l) as DeckEntry);
}

function parseExistingNarrative(md: string): { narrative: string; lastEntry: string | null } {
  // Extract narrative section between ## Narrative and ## Sources
  const narrativeMatch = md.match(/## Narrative\n([\s\S]*?)(?=\n## Sources|\n## |$)/);
  const narrative = narrativeMatch ? narrativeMatch[1].trim() : "";

  // Extract last-entry marker from sources section
  const lastEntryMatch = md.match(/- last-entry: (.+)/);
  const lastEntry = lastEntryMatch ? lastEntryMatch[1].trim() : null;

  return { narrative, lastEntry };
}

function renderProjectPage(codename: string, narrative: string, entries: DeckEntry[], existingMd: string): string {
  // Preserve existing identity fields if page exists
  let identity = [
    "- **Customer:** <!-- reconcile -->",
    "- **Period:** <!-- reconcile -->",
    "- **Engagement lead:** <!-- reconcile -->",
    "- **Customer representative:** <!-- reconcile -->",
    "- **Stack:** <!-- reconcile -->",
  ].join("\n");

  if (existingMd) {
    const identityMatch = existingMd.match(/## Identity\n([\s\S]*?)(?=\n## Narrative|\n## |$)/);
    if (identityMatch) identity = identityMatch[1].trim();
  }

  const lastEntry = entries.length > 0 ? entries[entries.length - 1].deck_name : "none";
  const slideCount = entries.reduce((s, e) => s + e.slide_count, 0);
  const deckCount = entries.length;

  return `# ${codename}
## Identity
${identity}

## Narrative
${narrative}

## Sources
- slides: ${slideCount} (${deckCount} decks)
- source: iteration-review-decks
- last-entry: ${lastEntry}
- last crawl: ${new Date().toISOString().slice(0, 10)}
- generated: ${new Date().toISOString().slice(0, 10)}
`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function updateCompiledTruth(codename: string): Promise<void> {
  const entries = loadEntries(codename);
  if (entries.length === 0) {
    console.error(`[compiled-truth] no deck entries found — run reduce phase first`);
    process.exit(1);
  }

  const projPath = projectPath(codename);
  const existingMd = existsSync(projPath) ? readFileSync(projPath, "utf-8") : "";

  // Determine which entries are new since last compiled-truth run
  const { narrative: existingNarrative, lastEntry } = parseExistingNarrative(existingMd);

  let newEntries: DeckEntry[];
  if (lastEntry) {
    const lastIdx = entries.findIndex(e => e.deck_name === lastEntry);
    newEntries = lastIdx >= 0 ? entries.slice(lastIdx + 1) : entries;
  } else {
    newEntries = entries;
  }

  if (newEntries.length === 0) {
    console.error(`[compiled-truth] compiled truth is up to date — no new entries`);
    return;
  }

  console.error(`[compiled-truth] ${newEntries.length} new entries to incorporate via ${MODEL_COMPILED_TRUTH}`);

  const newEntriesText = newEntries
    .map(e => `[${e.deck_date}] ${e.narrative}`)
    .join("\n\n");

  const prompt = renderPrompt("synthesize", "user", {
    codename,
    existingNarrative: existingNarrative || null,
    newEntries: newEntriesText,
  });

  const systemPrompt = renderPrompt("synthesize", "system", {});

  const response = await ollama.chat({
    model: MODEL_COMPILED_TRUTH,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.2 },
  });

  const narrative = response.message.content.trim();

  mkdirSync(dirname(projPath), { recursive: true });
  const page = renderProjectPage(codename, narrative, entries, existingMd);
  writeFileSync(projPath, page, "utf-8");

  console.error(`[compiled-truth] ✓ wrote ${projPath}`);
}
