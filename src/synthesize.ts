import { Ollama } from "ollama";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OLLAMA_URL, MODEL_COMPILED_TRUTH, statePath, projectPath } from "./config.js";
import { db } from "./db.js";
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
  // Use the deck's own date (from filename), not when extraction ran
  const [year, month, day] = entry.deck_date.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  const humanDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `### *${humanDate}* - Extracted from \`${entry.deck_filename ?? entry.deck_name}\` - (${entry.slide_count} Slides)`;
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

  const lastEntry = entries[entries.length - 1]?.deck_name ?? "none";

  return `# ${codename}
## Identity
${identity}

## Compiled Truth
<!-- last-entry: ${lastEntry} -->
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

// ── PG helpers ────────────────────────────────────────────────────────────────────

async function ensureProjectRow(codename: string): Promise<void> {
  await db().query(
    `INSERT INTO projects (codename) VALUES ($1) ON CONFLICT (codename) DO NOTHING`,
    [codename]
  );
}

async function getLatestEvidenceRunAt(codename: string): Promise<Date | null> {
  const { rows } = await db().query<{ max_run_at: Date | null }>(
    `SELECT MAX(run_at) AS max_run_at FROM evidence_trail WHERE codename = $1`,
    [codename]
  );
  return rows[0]?.max_run_at ?? null;
}

async function getCompiledTruthMeta(codename: string): Promise<{ evidence_cutoff: Date | null; model: string | null } | null> {
  const { rows } = await db().query<{ evidence_cutoff: Date | null; model: string | null }>(
    `SELECT evidence_cutoff, model FROM compiled_truth WHERE codename = $1`,
    [codename]
  );
  return rows[0] ?? null;
}

async function upsertCompiledTruth(codename: string, narrative: string, stack: string | null): Promise<void> {
  await db().query(
    `INSERT INTO compiled_truth (codename, narrative, stack, model, evidence_cutoff, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (codename) DO UPDATE
       SET narrative = EXCLUDED.narrative,
           stack = COALESCE(EXCLUDED.stack, compiled_truth.stack),
           model = EXCLUDED.model,
           evidence_cutoff = EXCLUDED.evidence_cutoff,
           updated_at = now()`,
    [codename, narrative, stack, MODEL_COMPILED_TRUTH]
  );
}

// ── Regenerate compiled truth from all entries (called after all decks reduce) ──

export async function updateCompiledTruth(codename: string): Promise<void> {
  const entries = loadEntries(codename);
  if (entries.length === 0) {
    console.error(`[compiled-truth] no deck entries found — run reduce phase first`);
    process.exit(1);
  }

  // Ensure project row exists
  try { await ensureProjectRow(codename); } catch {}

  // PG-based noop check: skip if no new evidence since last synthesis (same model)
  try {
    const latestEvidence = await getLatestEvidenceRunAt(codename);
    const ctMeta = await getCompiledTruthMeta(codename);
    if (ctMeta && latestEvidence && ctMeta.evidence_cutoff) {
      const sameModel = ctMeta.model === MODEL_COMPILED_TRUTH;
      const noNewEvidence = latestEvidence <= ctMeta.evidence_cutoff;
      if (sameModel && noNewEvidence) {
        console.error(`[compiled-truth] up to date (evidence_cutoff: ${ctMeta.evidence_cutoff.toISOString()}) — skipping`);
        return;
      }
      if (!sameModel) {
        console.error(`[compiled-truth] model changed (${ctMeta.model} → ${MODEL_COMPILED_TRUTH}) — re-running full synthesis`);
      }
    }
  } catch (err) {
    console.error(`[compiled-truth] PG noop check failed, continuing: ${err}`);
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

  // Write to PG compiled_truth
  try {
    await upsertCompiledTruth(codename, compiledTruth, null);
    console.error(`[compiled-truth] ✓ upserted PG compiled_truth for ${codename}`);
  } catch (err) {
    console.error(`[compiled-truth] ⚠ PG write failed: ${err}`);
  }
}

// ── Update stack in compiled_truth (called by extract-stack) ────────────────────────

export async function updateStackInPG(codename: string, stack: string): Promise<void> {
  await db().query(
    `INSERT INTO compiled_truth (codename, stack, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (codename) DO UPDATE
       SET stack = EXCLUDED.stack, updated_at = now()`,
    [codename, stack]
  );
}
