import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ingest } from "./ingest.js";
import { map } from "./map.js";
import { ingestDecks } from "./ingest-decks.js";
import { mapDecks } from "./map-decks.js";
import { embed } from "./embed.js";
import { cluster } from "./cluster.js";
import { reduce, saveNarratives, loadNarratives } from "./reduce.js";
import { synthesize } from "./synthesize.js";
import { clean } from "./clean.js";
import { CLAWRTEX_ROOT, statePath } from "./config.js";
import type { ExtractedThread, RegistryEntry } from "./types.js";

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const phase = arg("phase") ?? "all";
const codename = arg("codename");
const dl = arg("dl");
const source = arg("source") ?? "dl"; // "dl" | "decks"

// ── Registry lookup ───────────────────────────────────────────────────────────

function loadRegistry(): RegistryEntry[] {
  const p = resolve(CLAWRTEX_ROOT, "registry.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8")) as RegistryEntry[];
}

function lookupEntry(name: string): RegistryEntry | undefined {
  return loadRegistry().find(e => e.codename === name);
}

// ── Usage ─────────────────────────────────────────────────────────────────────

if (!codename) {
  console.error("Usage:");
  console.error("  DL source (default):");
  console.error("    npx tsx src/pipeline.ts --codename <name> --dl <address> [--phase all|ingest|map|embed|reduce|synthesize|clean|refresh]");
  console.error("");
  console.error("  Deck source:");
  console.error("    npx tsx src/pipeline.ts --codename <name> --source decks [--phase all|ingest|map|embed|reduce|synthesize|clean|refresh]");
  console.error("    (sharepoint site+folder read from ~/clawrtex/registry.json)");
  console.error("");
  console.error("  Examples:");
  console.error("    npx tsx src/pipeline.ts --codename tartan --source decks");
  console.error("    npx tsx src/pipeline.ts --codename rhyzono --source decks --phase ingest");
  console.error("    npx tsx src/pipeline.ts --codename tartan --dl tartan@southworks.com");
  process.exit(1);
}

// ── Resolve SharePoint config for deck runs ───────────────────────────────────

function requireSharePoint(name: string): { site: string; folder: string } {
  const entry = lookupEntry(name);
  if (!entry?.sharepoint) {
    throw new Error(
      `No SharePoint config for '${name}' in ~/clawrtex/registry.json.\n` +
      `Add: { "codename": "${name}", "sharepoint": { "site": "<site>", "folder": "<folder>" } }`
    );
  }
  return entry.sharepoint;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (source === "decks") {
  // ── Deck pipeline ────────────────────────────────────────────────────────────
  const sp = requireSharePoint(codename);

  switch (phase) {
    case "ingest": {
      await ingestDecks(codename, sp.site, sp.folder);
      break;
    }
    case "map": {
      await mapDecks(codename);
      break;
    }
    case "embed": {
      await embed(codename);
      break;
    }
    case "cluster": {
      await cluster(codename);
      break;
    }
    case "reduce": {
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      break;
    }
    case "synthesize": {
      const extractedPath = statePath(codename, "extracted.jsonl");
      if (!existsSync(extractedPath)) { console.error("Run map phase first"); process.exit(1); }
      const threads: ExtractedThread[] = readFileSync(extractedPath, "utf-8")
        .split("\n").filter(Boolean).map(l => JSON.parse(l) as ExtractedThread);
      let narratives = loadNarratives(codename);
      if (narratives) {
        console.error(`[pipeline] loaded ${narratives.length} cached narratives`);
      } else {
        const clusters = await cluster(codename);
        narratives = await reduce(clusters);
        saveNarratives(codename, narratives);
      }
      await synthesize(codename, narratives, threads, null);
      break;
    }
    case "clean": {
      await clean(codename);
      break;
    }
    case "refresh": {
      // Skip ingest, re-run map → clean
      const extracted = await mapDecks(codename);
      await embed(codename);
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      await synthesize(codename, narratives, extracted, null);
      await clean(codename);
      break;
    }
    case "all":
    default: {
      const threads = await ingestDecks(codename, sp.site, sp.folder);
      const extracted = await mapDecks(codename);
      await embed(codename);
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      await synthesize(codename, narratives, extracted, null);
      await clean(codename);
      break;
    }
  }
} else {
  // ── DL pipeline (original) ────────────────────────────────────────────────────

  switch (phase) {
    case "ingest": {
      if (!dl) { console.error("--dl required for ingest phase"); process.exit(1); }
      await ingest(codename, dl);
      break;
    }
    case "map": {
      await map(codename);
      break;
    }
    case "embed": {
      await embed(codename);
      break;
    }
    case "cluster": {
      await cluster(codename);
      break;
    }
    case "reduce": {
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      break;
    }
    case "synthesize": {
      if (!dl) { console.error("--dl required for synthesize phase"); process.exit(1); }
      const extractedPath = statePath(codename, "extracted.jsonl");
      if (!existsSync(extractedPath)) { console.error("Run map phase first"); process.exit(1); }
      const threads: ExtractedThread[] = readFileSync(extractedPath, "utf-8")
        .split("\n").filter(Boolean).map(l => JSON.parse(l) as ExtractedThread);
      let narratives = loadNarratives(codename);
      if (narratives) {
        console.error(`[pipeline] loaded ${narratives.length} cached narratives — skipping reduce`);
      } else {
        const clusters = await cluster(codename);
        narratives = await reduce(clusters);
        saveNarratives(codename, narratives);
      }
      await synthesize(codename, narratives, threads, dl);
      break;
    }
    case "clean": {
      await clean(codename);
      break;
    }
    case "refresh": {
      if (!dl) { console.error("--dl required for refresh phase"); process.exit(1); }
      const extracted = await map(codename);
      await embed(codename);
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      await synthesize(codename, narratives, extracted, dl);
      await clean(codename);
      break;
    }
    case "all": {
      if (!dl) { console.error("--dl required for all phases"); process.exit(1); }
      const threads = await ingest(codename, dl);
      const extracted = await map(codename);
      await embed(codename);
      const clusters = await cluster(codename);
      const narratives = await reduce(clusters);
      saveNarratives(codename, narratives);
      await synthesize(codename, narratives, extracted, dl);
      await clean(codename);
      break;
    }
    default:
      console.error(`Unknown phase: ${phase}`);
      process.exit(1);
  }
}
