import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = resolve(__dirname, "..");

// ── Env ───────────────────────────────────────────────────────────────────────

export const QDRANT_URL = process.env.QDRANT_URL ?? "https://qdrant.swrks.sh";
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "https://spark.swrks.sh/ollama";
export const CLAWRTEX_ROOT = process.env.CLAWRTEX_ROOT ?? resolve(process.env.HOME ?? "/tmp", "clawrtex");

// ── Credentials ───────────────────────────────────────────────────────────────

const credPath = resolve(
  process.env.CLAWRTEX_CREDENTIALS ?? resolve(PIPELINE_ROOT, "credentials.json")
);

interface Credentials {
  tenant_id: string;
  client_id: string;
  client_secret: string;
}

function loadCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(credPath, "utf-8")) as Credentials;
  } catch {
    throw new Error(`credentials.json not found at ${credPath} — copy it from Clawrence skill`);
  }
}

export const credentials = loadCredentials();

// ── Models ────────────────────────────────────────────────────────────────────

export const MODEL_MAP = "phi4:14b";
export const MODEL_EMBED = "qwen3-embedding:8b";
export const MODEL_REDUCE = "qwen3.6:35b";

// ── Paths ─────────────────────────────────────────────────────────────────────

// Suffix → subdirectory mapping
const STATE_DIRS: Record<string, string> = {
  "threads.jsonl":    ".threads",
  "extracted.jsonl":  ".extraction",
  "narratives.jsonl": ".narratives",
};

export function statePath(codename: string, suffix: string): string {
  const subdir = STATE_DIRS[suffix];
  if (subdir) {
    return resolve(CLAWRTEX_ROOT, "state", subdir, `${codename}.jsonl`);
  }
  // Fallback: project root file (e.g. nerine.json)
  return resolve(CLAWRTEX_ROOT, "state", `${codename}-${suffix}`);
}

export function projectPath(codename: string): string {
  return resolve(CLAWRTEX_ROOT, "projects", `${codename}.md`);
}

// ── Concurrency ───────────────────────────────────────────────────────────────

export const GRAPH_CONCURRENCY = 16;   // parallel post fetches
export const MAP_CONCURRENCY = 4;      // parallel phi4 calls (Spark GPU limit)
export const EMBED_CONCURRENCY = 8;    // parallel embedding calls
