import { ingestDecks } from "./ingest-decks.js";
import { mapDecks } from "./map-decks.js";
import { embed } from "./embed.js";
import { reduceDeck } from "./reduce.js";
import { updateCompiledTruth } from "./synthesize.js";
import { statePath } from "./config.js";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const phaseRaw = arg("phase") ?? "all";
const phases   = phaseRaw.split(",").map(p => p.trim()).filter(Boolean);
const codename = arg("codename");

if (!codename) {
  console.error("Usage:");
  console.error("  npx tsx src/pipeline.ts --codename <name> [--phase all|ingest|map|embed|reduce|compiled-truth]");
  console.error("");
  console.error("  Phases:");
  console.error("    ingest         — download new decks from SharePoint (incremental)");
  console.error("    map            — extract slide content via nemotron3:33b vision");
  console.error("    embed          — embed slide chunks into Qdrant");
  console.error("    reduce         — per-deck summarization → .entries/{codename}.jsonl");
  console.error("    compiled-truth — update compiled truth from new entries");
  console.error("    all            — run all phases in order (default)");
  console.error("");
  console.error("  Examples:");
  console.error("    npx tsx src/pipeline.ts --codename tartan");
  console.error("    npx tsx src/pipeline.ts --codename tartan --phase map");
  console.error("    npx tsx src/pipeline.ts --codename tartan --phase reduce,compiled-truth");
  process.exit(1);
}

// ── Ensure state dirs exist ───────────────────────────────────────────────────

for (const suffix of ["extracted.jsonl", "entries.jsonl"]) {
  const p = statePath(codename, suffix);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Phase runner ──────────────────────────────────────────────────────────────

async function runPhase(phase: string): Promise<void> {
  switch (phase) {
    case "ingest":
      await ingestDecks(codename!);
      break;

    case "map":
      await mapDecks(codename!);
      break;

    case "embed":
      await embed(codename!);
      break;

    case "reduce":
      await reduceDeck(codename!);
      break;

    case "compiled-truth":
      await updateCompiledTruth(codename!);
      break;

    case "all":
      await ingestDecks(codename!);
      await mapDecks(codename!);
      await embed(codename!);
      await reduceDeck(codename!);
      await updateCompiledTruth(codename!);
      break;

    default:
      console.error(`Unknown phase: ${phase}`);
      process.exit(1);
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

for (const phase of phases) {
  console.error(`[pipeline] ▶ phase: ${phase}`);
  await runPhase(phase);
}
