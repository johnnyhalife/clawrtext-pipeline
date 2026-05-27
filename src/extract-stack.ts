import { Ollama } from "ollama";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { OLLAMA_URL, MODEL_STACK, statePath, projectPath } from "./config.js";
import { renderPrompt } from "./prompts.js";
import type { DeckEntry } from "./reduce.js";

const ollama = new Ollama({ host: OLLAMA_URL });

function loadEntries(codename: string): DeckEntry[] {
  const p = statePath(codename, "entries.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as DeckEntry)
    .sort((a, b) => a.deck_date.localeCompare(b.deck_date));
}

function buildContext(codename: string, entries: DeckEntry[]): string {
  const pagePath = projectPath(codename);
  if (!existsSync(pagePath)) {
    return entries.map(e => e.narrative).join("\n\n");
  }

  const md = readFileSync(pagePath, "utf-8");
  // Extract compiled truth block (between the last-entry comment and ---)
  const ctMatch = md.match(/<!-- last-entry:.*?-->\n([\s\S]*?)(?=\n---|$)/);
  const compiledTruth = ctMatch ? ctMatch[1].trim() : "";

  // Use compiled truth only — full timeline causes model timeout at 31+ decks
  return compiledTruth || entries.map(e => e.narrative).join("\n\n");
}

export async function extractStack(codename: string): Promise<void> {
  const entries = loadEntries(codename);
  if (entries.length === 0) {
    console.error(`[extract-stack] no entries found — run reduce phase first`);
    return;
  }

  const context = buildContext(codename, entries);
  // Use qwen3.6:35b with think:false — nemotron3:33b exhausts num_predict on thinking, emits empty content
  console.error(`[extract-stack] extracting stack via ${MODEL_STACK} (context: ${context.length} chars)`);

  const response = await ollama.chat({
    model: MODEL_STACK,
    think: false,
    messages: [
      { role: "system", content: renderPrompt("stack", "system") },
      { role: "user",   content: renderPrompt("stack", "user", { context }) },
    ],
    options: { temperature: 0.0, num_predict: 800 },
  });

  const raw = response.message.content.trim();
  console.error(`[extract-stack] raw output: ${raw.slice(0, 400)}`);

  // Known aliases: map verbose form → canonical short form (add as needed)
  const ALIASES: Record<string, string> = {
    "azure kubernetes service": "AKS",
    "google kubernetes engine":  "GKE",
    "amazon elastic kubernetes service": "EKS",
    "azure container registry": "ACR",
    "azure container apps":     "ACA",
    "azure active directory":   "Entra ID",
    "microsoft entra id":       "Entra ID",
    "github actions":           "GitHub Actions",
  };

  // Normalize: strip bullets, apply aliases, case-insensitive dedup, sort
  const seen = new Map<string, string>(); // lowercase key → preferred display form
  for (const raw_item of raw.split(",")) {
    const s = raw_item.trim().replace(/^[-•*\s]+/, "");
    if (!s || s.length >= 80) continue;
    const key = s.toLowerCase();
    const canonical = ALIASES[key] ?? s;
    const canonicalKey = canonical.toLowerCase();
    if (!seen.has(canonicalKey)) seen.set(canonicalKey, canonical);
  }

  // Drop items that are a substring of a more-specific item (e.g. "LangChain" ⊂ "LangChain Agent")
  const deduped = [...seen.values()].filter(item => {
    const lower = item.toLowerCase();
    return ![...seen.values()].some(other => {
      if (other === item) return false;
      const otherLower = other.toLowerCase();
      return otherLower.includes(lower) && otherLower !== lower;
    });
  });

  const items = deduped.sort((a, b) => a.localeCompare(b));

  const stack = items.join(", ");
  console.error(`[extract-stack] ${items.length} items extracted`);

  // Write state file
  const stackPath = statePath(codename, "stack.txt");
  writeFileSync(stackPath, stack, "utf-8");
  console.error(`[extract-stack] ✓ wrote ${stackPath}`);

  // Patch Identity block in project page
  const pagePath = projectPath(codename);
  if (existsSync(pagePath)) {
    const md = readFileSync(pagePath, "utf-8");
    const patched = md.replace(/- \*\*Stack:\*\* .*/, `- **Stack:** ${stack}`);
    if (patched !== md) {
      writeFileSync(pagePath, patched, "utf-8");
      console.error(`[extract-stack] ✓ patched Stack in ${pagePath}`);
    }
  }
}
