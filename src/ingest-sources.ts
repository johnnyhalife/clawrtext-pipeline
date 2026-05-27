/**
 * ingest-sources.ts
 *
 * Imports registry.json into the projects + project_sources tables.
 * Safe to re-run — upserts on conflict.
 *
 * Usage:
 *   npx tsx src/ingest-sources.ts [--registry <path>]
 *   npx tsx src/ingest-sources.ts --codename tartan   # single project
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db, closeDb } from "./db.js";
import { CLAWRTEX_ROOT } from "./config.js";

interface RegistryEntry {
  codename: string;
  sharepoint?: { site: string; folder: string };
  [key: string]: unknown;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const registryPath = arg("registry") ?? resolve(CLAWRTEX_ROOT, "registry.json");
const filterCodename = arg("codename");

async function run(): Promise<void> {
  if (!existsSync(registryPath)) {
    console.error(`[ingest-sources] registry not found: ${registryPath}`);
    process.exit(1);
  }

  const registry: RegistryEntry[] = JSON.parse(readFileSync(registryPath, "utf-8"));
  const entries = filterCodename
    ? registry.filter(e => e.codename === filterCodename)
    : registry;

  if (entries.length === 0) {
    console.error(`[ingest-sources] no entries found${filterCodename ? ` for codename '${filterCodename}'` : ""}`);
    process.exit(1);
  }

  console.error(`[ingest-sources] importing ${entries.length} project(s) from ${registryPath}`);

  const pool = db();

  for (const entry of entries) {
    const { codename, sharepoint, ...rest } = entry;

    // Upsert project row
    await pool.query(
      `INSERT INTO projects (codename) VALUES ($1)
       ON CONFLICT (codename) DO NOTHING`,
      [codename]
    );
    console.error(`[ingest-sources] ✓ project: ${codename}`);

    // Upsert sharepoint_decks source
    if (sharepoint) {
      const config = { site: sharepoint.site, folder: sharepoint.folder };
      await pool.query(
        `INSERT INTO project_sources (codename, source_type, config)
         VALUES ($1, 'sharepoint_decks', $2)
         ON CONFLICT (codename, source_type) DO UPDATE
           SET config = EXCLUDED.config`,
        [codename, JSON.stringify(config)]
      );
      console.error(`[ingest-sources]   └ source: sharepoint_decks → site=${sharepoint.site}, folder=${sharepoint.folder}`);
    }

    // Future source types: email_dl, slack_channel, etc.
    // Add new blocks here as new source types are introduced.
  }

  console.error(`[ingest-sources] done.`);
}

run().finally(closeDb);
