import { ingest } from "./ingest.js";

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
  case "map":
  case "embed":
  case "reduce":
  case "synthesize":
  case "all":
    console.error(`[pipeline] phase '${phase}' not yet implemented`);
    break;
  default:
    console.error(`Unknown phase: ${phase}`);
    process.exit(1);
}
