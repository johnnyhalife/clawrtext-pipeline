import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = resolve(__dirname, "..");

// ── Env ───────────────────────────────────────────────────────────────────────

export const OLLAMA_URL    = process.env.OLLAMA_URL    ?? "https://spark.swrks.sh/ollama";
export const CLAWRTEX_ROOT = process.env.CLAWRTEX_ROOT ?? resolve(process.env.HOME ?? "/tmp", "clawrtex");

// ── Postgres (pgvector) ───────────────────────────────────────────────────────

function pgPassword(): string {
  // 1. Explicit env var
  if (process.env.CLAWRTEX_PG_PASSWORD) return process.env.CLAWRTEX_PG_PASSWORD;
  // 2. Secret file (harness default)
  const secretPath = process.env.CLAWRTEX_PG_PASSWORD_FILE
    ?? resolve(process.env.HOME ?? "/tmp", "clawdio-harness/secrets/clawrtex_pg_password");
  try { return readFileSync(secretPath, "utf-8").trim(); } catch {}
  throw new Error(`clawrtex pg password not found — set CLAWRTEX_PG_PASSWORD or ensure ${secretPath} exists`);
}

export const PG_HOST     = process.env.CLAWRTEX_PG_HOST ?? "127.0.0.1";
export const PG_PORT     = Number(process.env.CLAWRTEX_PG_PORT ?? 5435);
export const PG_DATABASE = process.env.CLAWRTEX_PG_DATABASE ?? "clawrtex";
export const PG_USER     = process.env.CLAWRTEX_PG_USER     ?? "clawrtex";
export const PG_PASSWORD = pgPassword();

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
    throw new Error(`credentials.json not found at ${credPath}`);
  }
}

export const credentials = loadCredentials();

// ── Models ────────────────────────────────────────────────────────────────────

interface ModelsYaml { [stage: string]: string; }

function loadModelsYaml(): ModelsYaml {
  const p = resolve(PIPELINE_ROOT, "models.yaml");
  if (!existsSync(p)) return {};
  try {
    return (yaml.load(readFileSync(p, "utf-8")) ?? {}) as ModelsYaml;
  } catch (e) {
    console.error(`[config] failed to parse models.yaml: ${e}`);
    return {};
  }
}

const modelsYaml = loadModelsYaml();

function modelFor(stage: string, envVar: string, fallback: string): string {
  return process.env[envVar] ?? modelsYaml[stage] ?? fallback;
}

export const MODEL_MAP_DECKS      = modelFor("map-decks",      "MODEL_MAP_DECKS",      "nemotron3:33b");
export const MODEL_EMBED          = modelFor("embed",           "MODEL_EMBED",           "qwen3-embedding:8b");
export const MODEL_REDUCE         = modelFor("reduce",          "MODEL_REDUCE",          "qwen3.6:35b");
export const MODEL_COMPILED_TRUTH = modelFor("compiled-truth",  "MODEL_COMPILED_TRUTH",  "qwen3.6:35b");
export const MODEL_STACK          = modelFor("stack",           "MODEL_STACK",           "qwen3.6:35b");

// ── Paths ─────────────────────────────────────────────────────────────────────

const STATE_DIRS: Record<string, string> = {
  "extracted.jsonl": ".extraction",
  "entries.jsonl":   ".entries",
};

export function statePath(codename: string, suffix: string): string {
  const subdir = STATE_DIRS[suffix];
  if (subdir) {
    return resolve(CLAWRTEX_ROOT, "state", subdir, `${codename}.jsonl`);
  }
  return resolve(CLAWRTEX_ROOT, "state", `${codename}-${suffix}`);
}

export function projectPath(codename: string): string {
  return resolve(CLAWRTEX_ROOT, "projects", `${codename}.md`);
}

// ── Concurrency ───────────────────────────────────────────────────────────────

export const MAP_CONCURRENCY    = Number(process.env.MAP_CONCURRENCY    ?? 4);
export const EMBED_CONCURRENCY  = Number(process.env.EMBED_CONCURRENCY  ?? 8);
export const REDUCE_CONCURRENCY = Number(process.env.REDUCE_CONCURRENCY ?? 4);  // Spark GB10 handles 4 parallel qwen3.6:35b calls comfortably

// ── Date parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a deck date from a filename or slug, returning "YYYY-MM-DD".
 * Handles:
 *   "2025-07-14 - Iteration 1"  → "2025-07-14"
 *   "20260420 - Iteration Review.pptx" → "2026-04-20"
 *   "20260420-iteration-review"  → "2026-04-20"
 * Falls back to `fallback` (default "unknown") if no date found.
 */
export function parseDeckDate(name: string, fallback = "unknown"): string {
  // Try YYYY-MM-DD anywhere in name first
  const dashed = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (dashed) return dashed[1];
  // Try YYYYMMDD anywhere in name
  const compact = name.match(/(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return fallback;
}
