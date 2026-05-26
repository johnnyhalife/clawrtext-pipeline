import { ingestDecks } from "./ingest-decks.js";
import { mapDecks } from "./map-decks.js";
import { embed } from "./embed.js";
import { reduceDeck, reduceDecks, groupByDeck } from "./reduce.js";
import { updateCompiledTruth } from "./synthesize.js";

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const phaseRaw  = arg("phase") ?? "all";
const phases    = phaseRaw.split(",").map(p => p.trim()).filter(Boolean);
const codename  = arg("codename");
const deckFilter = arg("deck"); // optional: restrict to one deck filename

if (!codename) {
  console.error("Usage:");
  console.error("  npx tsx src/pipeline.ts --codename <name> [--phase <phase>]");
  console.error("");
  console.error("  Phases:");
  console.error("    ingest         — download new decks from SharePoint (incremental)");
  console.error("    map            — extract + reduce: nemotron reads slides, entries written per deck");
  console.error("    embed          — embed slide chunks into Qdrant");
  console.error("    compiled-truth — update compiled truth from new entries");
  console.error("    all            — run all phases in order (default)");
  console.error("    reduce         — standalone reduce from .extraction cache (dev/retry only)");
  console.error("");
  console.error("  Examples:");
  console.error("    npx tsx src/pipeline.ts --codename eulophia");
  console.error("    npx tsx src/pipeline.ts --codename eulophia --phase map");
  console.error("    npx tsx src/pipeline.ts --codename eulophia --phase compiled-truth");
  process.exit(1);
}

// ── Phase runner ──────────────────────────────────────────────────────────────

async function runPhase(phase: string): Promise<void> {
  switch (phase) {
    case "ingest":
      await ingestDecks(codename!, deckFilter);
      break;

    case "map": {
      // map + reduce in one pass: each deck is reduced and appended as soon as its slides are extracted
      const extracted = await mapDecks(codename!, deckFilter);
      await reduceDecks(codename!, groupByDeck(extracted));
      break;
    }

    case "embed":
      await embed(codename!);
      break;

    case "compiled-truth":
      await updateCompiledTruth(codename!);
      break;

    case "reduce":
      // Standalone: reads from .extraction cache — use when retrying reduce without re-running nemotron
      await reduceDeck(codename!);
      break;

    case "all":
      await ingestDecks(codename!, deckFilter);
      const extracted = await mapDecks(codename!, deckFilter);
      await reduceDecks(codename!, groupByDeck(extracted));
      await embed(codename!);
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
