import { readFileSync, writeFileSync, existsSync } from "fs";
import { Ollama } from "ollama";
import { projectPath } from "./config.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "https://spark.swrks.sh/ollama";
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

  const prompt = `You are a copy editor working on a software engineering project history page.

Below is the raw narrative for a project. It may contain paragraphs that say a section had no content, no technical work, or was internal logistics only — remove those entirely. The remaining paragraphs describe different phases of the same project and should read as one cohesive narrative.

Your job:
- Remove any paragraph that states it has no technical content or is purely internal logistics
- Do not add any new technical information or facts
- Do not change or invent technical details, names, or outcomes
- Do not reorder paragraphs
- Add brief transitional phrases between paragraphs where needed to connect the phases naturally
- Output one flowing narrative suitable for a client-facing project history page
- Return ONLY the edited narrative, no headings, no commentary

Raw narrative:
${narrativeBody}`;

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
