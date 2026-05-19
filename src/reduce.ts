import { Ollama } from "ollama";
import pLimit from "p-limit";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { OLLAMA_URL, MODEL_REDUCE, REDUCE_CONCURRENCY, statePath } from "./config.js";
import type { Cluster, ClusterNarrative } from "./types.js";

const ollama = new Ollama({ host: OLLAMA_URL });

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(cluster: Cluster): string {
  const summaries = cluster.threads
    .map(t => `- [${t.topic}] ${t.summary}`)
    .join("\n");

  const decisions = cluster.threads
    .flatMap(t => t.decisions)
    .filter(Boolean)
    .slice(0, 20);

  const actionItems = cluster.threads
    .flatMap(t => t.action_items)
    .filter(Boolean)
    .slice(0, 20);

  return `You are writing one paragraph for a software engineering project's history page.

You have been given a cluster of related email threads. Synthesize them into a single paragraph.

CRITICAL RULES — violations make the output useless:
- ONLY use information explicitly present in the thread summaries below. Do not infer, generalize, or fill gaps.
- If a technology, person, or decision is not mentioned in the summaries, do not include it.
- If the cluster lacks enough signal to write a grounded paragraph, write exactly one sentence describing what little is known, then stop. Do not pad with generic software engineering language.
- Never use generic filler phrases like "microservices architecture", "scalability", "seamless integration", "robust solution", or "exceeded expectations" unless those exact words appear in the source.

The paragraph should answer (using only what's in the threads):
- WHAT was built or delivered?
- WHY did it matter? (client need, technical problem)
- HOW was it done? (specific technology, decision, outcome)

If this cluster is dominated by internal logistics with no engineering substance, write: "Internal coordination threads — no engineering signal."

Thread summaries:
${summaries}

${decisions.length > 0 ? `Decisions from threads:\n${decisions.map(d => `- ${d}`).join("\n")}\n` : ""}

Write a single factual paragraph (3-6 sentences):
- Grounded strictly in the thread summaries above
- Names technologies and people only if they appear in the source
- Plain, neutral language — no spin, no adjectives like "excellent" or "innovative"
- No sprint labels, iteration numbers, or milestone names

Return ONLY the paragraph text. No headings, no bullets, no explanation.`;
}

// ── Cluster signal helpers ───────────────────────────────────────────────────

function externalRatio(cluster: Cluster): number {
  if (cluster.threads.length === 0) return 0;
  return cluster.threads.filter(t => t.has_external).length / cluster.threads.length;
}

// ── Reduce one cluster ────────────────────────────────────────────────────────

async function reduceCluster(cluster: Cluster): Promise<ClusterNarrative> {
  const ext = externalRatio(cluster);

  // Skip trivial single-thread clusters — just use the summary directly
  if (cluster.threads.length === 1) {
    return {
      cluster_id: cluster.id,
      narrative: cluster.threads[0].summary,
      thread_count: 1,
      topics: [cluster.threads[0].topic],
      external_ratio: ext,
    };
  }

  try {
    const response = await ollama.chat({
      model: MODEL_REDUCE,
      messages: [{ role: "user", content: buildPrompt(cluster) }],
      options: { temperature: 0.3 },
    });

    return {
      cluster_id: cluster.id,
      narrative: response.message.content.trim(),
      thread_count: cluster.threads.length,
      topics: cluster.threads.map(t => t.topic),
      external_ratio: ext,
    };
  } catch (err) {
    console.error(`[reduce] cluster ${cluster.id} failed: ${err}`);
    // Fallback: join summaries
    return {
      cluster_id: cluster.id,
      narrative: cluster.threads.map(t => t.summary).join(" "),
      thread_count: cluster.threads.length,
      topics: cluster.threads.map(t => t.topic),
      external_ratio: ext,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function reduce(clusters: Cluster[]): Promise<ClusterNarrative[]> {
  console.error(`[reduce] reducing ${clusters.length} clusters via ${MODEL_REDUCE}`);

  console.error(`[reduce] concurrency=${REDUCE_CONCURRENCY}`);
  const limit = pLimit(REDUCE_CONCURRENCY);
  let done = 0;

  const narratives = await Promise.all(
    clusters.map(c =>
      limit(async () => {
        const narrative = await reduceCluster(c);
        done++;
        console.error(`[reduce] ${done}/${clusters.length} clusters reduced`);
        return narrative;
      })
    )
  );

  return narratives;
}

// ── Persist / load narratives checkpoint ─────────────────────────────────────

export function saveNarratives(codename: string, narratives: ClusterNarrative[]): void {
  const path = statePath(codename, "narratives.jsonl");
  writeFileSync(path, narratives.map(n => JSON.stringify(n)).join("\n") + "\n", "utf-8");
  console.error(`[reduce] wrote ${narratives.length} narratives → ${path}`);
}

export function loadNarratives(codename: string): ClusterNarrative[] | null {
  const path = statePath(codename, "narratives.jsonl");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as ClusterNarrative);
}
