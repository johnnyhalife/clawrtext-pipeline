import { readFileSync, existsSync } from "fs";
import { ingest } from "./ingest.js";
import { map } from "./map.js";
import { embed } from "./embed.js";
import { cluster } from "./cluster.js";
import { reduce, saveNarratives, loadNarratives } from "./reduce.js";
import { synthesize } from "./synthesize.js";
import { statePath } from "./config.js";
import type { ExtractedThread } from "./types.js";

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const phase = arg("phase") ?? "all";
const codename = arg("codename");
const dl = arg("dl");

if (!codename) {
  console.error("Usage: tsx src/pipeline.ts --codename <name> [--dl <address>] [--phase ingest|map|embed|reduce|synthesize|all]");
  process.exit(1);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

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
  case "all": {
    if (!dl) { console.error("--dl required for all phases"); process.exit(1); }
    const threads = await ingest(codename, dl);
    const extracted = await map(codename);
    await embed(codename);
    const clusters = await cluster(codename);
    const narratives = await reduce(clusters);
    await synthesize(codename, narratives, extracted, dl);
    break;
  }
  default:
    console.error(`Unknown phase: ${phase}`);
    process.exit(1);
}
