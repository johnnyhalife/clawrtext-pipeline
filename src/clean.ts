import { readFileSync, writeFileSync, existsSync } from "fs";
import { Ollama } from "ollama";
import { projectPath } from "./config.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "https://spark.swrks.sh/ollama";
const CLEAN_MODEL = process.env.CLEAN_MODEL ?? "gemma4:26b";

const LOGISTICS_PATTERNS = [
  /^This cluster (consists|is dominated|contains|has no)/i,
  /^The provided (thread|email|communication)/i,
  /^(These|This) (thread summaries?|cluster of communications?|communications?|emails?) (consist|are|is) (entirely of|dominated by) (routine|internal|daily)/i,
  /with no documented (engineering|technical|architectural|specific)/i,
  /no (substantive|documented|specific) (technical|engineering|architectural)/i,
];

function isLogisticsParagraph(para: string): boolean {
  const trimmed = para.trim();
  return LOGISTICS_PATTERNS.some(p => p.test(trimmed));
}

export async function clean(codename: string): Promise<void> {
  const pagePath = projectPath(codename);
  if (!existsSync(pagePath)) {
    throw new Error(`Project page not found: ${pagePath} — run synthesize first`);
  }

  const page = readFileSync(pagePath, "utf-8");

  // Split out the Narrative section
  const narrativeMatch = page.match(/^(## Narrative\n)([\s\S]*?)(^## Sources)/m);
  if (!narrativeMatch) {
    console.error("[clean] no Narrative section found — skipping");
    return;
  }

  const beforeNarrative = page.slice(0, narrativeMatch.index!);
  const afterNarrative = page.slice(narrativeMatch.index! + narrativeMatch[0].length);
  const narrativeBody = narrativeMatch[2];

  // Split into paragraphs and filter logistics-only ones
  const paragraphs = narrativeBody.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const technical = paragraphs.filter(p => !isLogisticsParagraph(p));
  const removed = paragraphs.length - technical.length;

  console.error(`[clean] ${paragraphs.length} paragraphs, removing ${removed} logistics-only`);

  if (technical.length === 0) {
    console.error("[clean] nothing left after filtering — keeping original");
    return;
  }

  // LLM pass: smooth transitions and remove any remaining logistics references
  const ollama = new Ollama({ host: OLLAMA_URL, fetch: (url: RequestInfo | URL, init?: RequestInit) => fetch(url as RequestInfo, { ...init, signal: AbortSignal.timeout(300_000) }) });

  const prompt = `You are a copy editor. Your only job is to clean up the text below.

Rules:
- Remove any sentence that states a section had no content, no technical work, no deliverables, or was internal logistics
- Do not add any new information
- Do not change any technical facts, names, or details
- Do not reorder paragraphs
- Fix transitions between paragraphs only where a removed sentence left an awkward join
- Return ONLY the edited text, paragraph breaks preserved, no headings, no commentary

Text to edit:
${technical.join("\n\n")}`;

  console.error(`[clean] running LLM cleanup with ${CLEAN_MODEL}`);

  const response = await ollama.chat({
    model: CLEAN_MODEL,
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.1 },
    keep_alive: "10m",
  } as Parameters<typeof ollama.chat>[0]);

  const cleaned = response.message.content.trim();

  const newPage = `${beforeNarrative}## Narrative\n${cleaned}\n\n## Sources${afterNarrative}`;
  writeFileSync(pagePath, newPage, "utf-8");
  console.error(`[clean] wrote cleaned page → ${pagePath}`);
}
