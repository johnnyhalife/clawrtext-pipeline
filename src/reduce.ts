import { Ollama } from "ollama";
import pLimit from "p-limit";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { OLLAMA_URL, MODEL_REDUCE, statePath } from "./config.js";
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

  return `You are writing one paragraph for a software engineering project's history page. A reader should finish your paragraph understanding what was built, why it mattered, and how the team approached it.

You have been given a cluster of related email threads from the project. Synthesize them into a single paragraph that answers:
- WHAT was built or delivered? (system, component, feature, tool)
- WHY did it matter? (client need, technical problem, constraint being solved)
- HOW was it done? (architecture choice, key decision, method, outcome)

If this cluster is dominated by internal logistics (standups, task assignments, routine coordination) with no engineering substance, write one sentence acknowledging that and stop.

Thread summaries:
${summaries}

${decisions.length > 0 ? `Decisions from threads:\n${decisions.map(d => `- ${d}`).join("\n")}\n` : ""}

Write a single factual paragraph (3-6 sentences) that:
- Answers what/why/how using specific technical details from the threads
- Names real technologies, tools, systems, and people only if they appear in the source
- Uses plain, neutral language — no spin, no adjectives like "excellent" or "innovative"
- Is suitable as a section of a client-facing project history page
- Do not reference internal iteration numbers, sprint labels, or cycle names (e.g. "Iteration #3", "Sprint 2") — describe the work, not the milestone label

Return ONLY the paragraph text, no headings, no bullet points, no explanation.`;
}

// ── Cluster signal helpers ───────────────────────────────────────────────────

function externalRatio(cluster: Cluster): number {
  if (cluster.threads.length === 0) return 0;
  return cluster.threads.filter(t => t.has_external).length / cluster.threads.length;
}

function hasDecisions(cluster: Cluster): boolean {
  return cluster.threads.some(t => t.decisions.length > 0);
}

// ── Reduce one cluster ────────────────────────────────────────────────────────

async function reduceCluster(cluster: Cluster): Promise<ClusterNarrative> {
  const ext = externalRatio(cluster);
  const decisions = hasDecisions(cluster);

  // Skip trivial single-thread clusters — just use the summary directly
  if (cluster.threads.length === 1) {
    return {
      cluster_id: cluster.id,
      narrative: cluster.threads[0].summary,
      thread_count: 1,
      topics: [cluster.threads[0].topic],
      external_ratio: ext,
      has_decisions: decisions,
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
      has_decisions: decisions,
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
      has_decisions: decisions,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function reduce(clusters: Cluster[]): Promise<ClusterNarrative[]> {
  console.error(`[reduce] reducing ${clusters.length} clusters via ${MODEL_REDUCE}`);

  // Run 2 at a time — gemma4:26b is large, don't thrash
  const limit = pLimit(2);
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
