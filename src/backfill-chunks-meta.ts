/**
 * backfill-chunks-meta.ts
 *
 * Backfills deck_date and source_url on existing chunks that have nulls.
 *
 * Join key: chunks.deck_name === extraction JSONL topic
 * Source:   .state/.extraction/<codename>.jsonl (has deck_filename passthrough)
 * Date:     parseDeckDate(deck_filename) — same logic as ingest-decks
 * URL:      sharePointUrl(site, folder, deck_filename) — from registry.json
 *
 * Both are deterministic — no LLM, no API calls.
 *
 * Usage:
 *   npx tsx src/backfill-chunks-meta.ts
 *   npx tsx src/backfill-chunks-meta.ts --codename tartan
 *   npx tsx src/backfill-chunks-meta.ts --dry-run
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db, closeDb } from "./db.js";
import { CLAWRTEX_ROOT, parseDeckDate } from "./config.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
const filterCodename = arg("codename");
const dryRun = process.argv.includes("--dry-run");

// ── Registry ──────────────────────────────────────────────────────────────────

interface RegistryEntry {
  codename: string;
  sharepoint?: { site: string; folder: string };
}

function loadRegistry(): Map<string, { site: string; folder: string }> {
  const p = resolve(CLAWRTEX_ROOT, "registry.json");
  if (!existsSync(p)) throw new Error(`registry.json not found at ${p}`);
  const entries = JSON.parse(readFileSync(p, "utf-8")) as RegistryEntry[];
  const map = new Map<string, { site: string; folder: string }>();
  for (const e of entries) {
    if (e.sharepoint) map.set(e.codename, e.sharepoint);
  }
  return map;
}

function sharePointUrl(site: string, folder: string, filename: string): string {
  return `https://southworks365.sharepoint.com/sites/${site}/Shared%20Documents/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const registry = loadRegistry();
  const pool = db();

  // Fetch chunks missing deck_date or source_url
  const params: string[] = [];
  const whereCodename = filterCodename ? `AND codename = $1` : "";
  if (filterCodename) params.push(filterCodename);

  const { rows } = await pool.query<{
    id: number;
    codename: string;
    deck_name: string;
    deck_date: string | null;
    source_url: string | null;
  }>(
    `SELECT id, codename, deck_name, deck_date, source_url
     FROM chunks
     WHERE (deck_date IS NULL OR source_url IS NULL)
       AND deck_name IS NOT NULL
       ${whereCodename}
     ORDER BY codename, deck_name`,
    params
  );

  console.error(`[backfill-chunks-meta] ${rows.length} chunks need backfill${filterCodename ? ` (${filterCodename})` : ""}`);
  if (dryRun) console.error(`[backfill-chunks-meta] DRY RUN — no writes`);

  // Group by codename
  const byCodename = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byCodename.get(row.codename) ?? [];
    bucket.push(row);
    byCodename.set(row.codename, bucket);
  }

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const [codename, chunks] of byCodename) {
    const sp = registry.get(codename);
    if (!sp) {
      console.error(`[backfill-chunks-meta] WARN no registry entry for ${codename} — skipping ${chunks.length} chunks`);
      totalSkipped += chunks.length;
      continue;
    }

    // Build topic → {deckDate, sourceUrl} from extraction JSONL
    // Join key: extraction.topic === chunks.deck_name (both are LLM-extracted slide titles)
    const extractionPath = resolve(CLAWRTEX_ROOT, ".state", ".extraction", `${codename}.jsonl`);
    const topicMap = new Map<string, { deckDate: string; sourceUrl: string }>();

    if (existsSync(extractionPath)) {
      const lines = readFileSync(extractionPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { topic?: string; deck_filename?: string; _hash?: string };
          if (!entry.topic || !entry.deck_filename) continue;
          const deckDate = parseDeckDate(entry.deck_filename, "");
          if (!deckDate) continue;
          const sourceUrl = sharePointUrl(sp.site, sp.folder, entry.deck_filename);
          // topic is the join key — may appear multiple times (same slide title across decks);
          // last-write wins (all entries for the same topic get the same date/url per deck anyway)
          topicMap.set(entry.topic, { deckDate, sourceUrl });
        } catch { /* skip malformed */ }
      }
      console.error(`[backfill-chunks-meta] ${codename}: ${topicMap.size} unique topics from extraction JSONL`);
    } else {
      console.error(`[backfill-chunks-meta] WARN extraction JSONL not found for ${codename}: ${extractionPath}`);
      totalSkipped += chunks.length;
      continue;
    }

    let updated = 0;
    let skipped = 0;

    for (const chunk of chunks) {
      const match = topicMap.get(chunk.deck_name);
      if (!match) {
        // Topic not in extraction — chunk may have been embedded before deck_filename passthrough was added
        skipped++;
        continue;
      }

      const deckDate = chunk.deck_date ?? match.deckDate;
      const sourceUrl = chunk.source_url ?? match.sourceUrl;

      if (dryRun) {
        console.error(`[backfill-chunks-meta] DRY id=${chunk.id} deck_date=${deckDate} url=${sourceUrl.slice(0, 80)}...`);
        updated++;
        continue;
      }

      await pool.query(
        `UPDATE chunks SET
           deck_date  = COALESCE($1::date, deck_date),
           source_url = COALESCE($2, source_url)
         WHERE id = $3`,
        [deckDate || null, sourceUrl, chunk.id]
      );
      updated++;
    }

    console.error(`[backfill-chunks-meta] ${codename}: updated=${updated} skipped=${skipped}`);
    totalUpdated += updated;
    totalSkipped += skipped;
  }

  console.error(`[backfill-chunks-meta] done — total updated=${totalUpdated} skipped=${totalSkipped}`);
}

run().catch(e => {
  console.error("[backfill-chunks-meta] fatal:", e);
  process.exit(1);
}).finally(closeDb);
