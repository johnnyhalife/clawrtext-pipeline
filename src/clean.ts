import { readFileSync, writeFileSync, existsSync } from "fs";
import { Ollama } from "ollama";
import { projectPath, OLLAMA_URL } from "./config.js";
import { renderPrompt } from "./prompts.js";

const CLEAN_MODEL = process.env.CLEAN_MODEL ?? "qwen3.6:35b";

export async function clean(codename: string): Promise<void> {
  const pagePath = projectPath(codename);
  if (!existsSync(pagePath)) {
    throw new Error(`Project page not found: ${pagePath} — run synthesize first`);
  }

  const page = readFileSync(pagePath, "utf-8");

  // Extract the Narrative section
  const narrativeMatch = page.match(/^(## Narrative\n)([\s\S]*?)(^## Sources)/m);
  if (!narrativeMatch) {
    console.error("[clean] no Narrative section found — skipping");
    return;
  }

  const before = page.slice(0, narrativeMatch.index!) + "## Narrative\n";
  const narrativeBody = narrativeMatch[2].trim();
  const after = "\n\n## Sources" + page.slice(narrativeMatch.index! + narrativeMatch[0].length);

  console.error(`[clean] running editorial pass on full narrative with ${CLEAN_MODEL}`);

  const ollama = new Ollama({
    host: OLLAMA_URL,
    fetch: (url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url as RequestInfo, { ...init, signal: AbortSignal.timeout(600_000) }),
  });

  const prompt = renderPrompt("clean", "user", { narrativeBody });

  const response = await ollama.chat({
    model: CLEAN_MODEL,
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.1 },
  });

  const cleaned = response.message.content.trim();
  const newPage = `${before}${cleaned}${after}`;
  writeFileSync(pagePath, newPage, "utf-8");
  console.error(`[clean] wrote cleaned page → ${pagePath}`);
}
