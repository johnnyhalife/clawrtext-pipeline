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

  return `You are writing a factual narrative paragraph for a section of a software project's history page.

You have been given a cluster of related email threads. Synthesize only what matters for understanding what was built, decided, and delivered on this project.

Focus on: technical work, architectural decisions, deliverables, external interactions, and outcomes.
Ignore: internal logistics, daily standups, routine status pings, training progress, certification completions, time-off, and administrative coordination. If this cluster is dominated by logistics with no technical or business substance, write a single sentence noting that and move on.

Thread summaries:
${summaries}

${decisions.length > 0 ? `Key decisions made:\n${decisions.map(d => `- ${d}`).join("\n")}\n` : ""}
${actionItems.length > 0 ? `Key action items:\n${actionItems.map(a => `- ${a}`).join("\n")}\n` : ""}

Write a single factual paragraph (3-6 sentences) that:
- Describes what technical or business work this cluster represents
- Mentions specific outcomes, decisions, or deliverables where they exist
- Uses plain, neutral language — no spin, no adjectives like "excellent" or "successful"
- Only uses names that appear in the source threads — do not invent names
- Is suitable as a section of a client-facing project history page

Return ONLY the paragraph text, no headings, no bullet points, no explanation.`;
}

// ── Reduce one cluster ────────────────────────────────────────────────────────

async function reduceCluster(cluster: Cluster): Promise<ClusterNarrative> {
  // Skip trivial single-thread clusters — just use the summary directly
  if (cluster.threads.length === 1) {
    return {
      cluster_id: cluster.id,
      narrative: cluster.threads[0].summary,
      thread_count: 1,
      topics: [cluster.threads[0].topic],
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
    };
  } catch (err) {
    console.error(`[reduce] cluster ${cluster.id} failed: ${err}`);
    // Fallback: join summaries
    return {
      cluster_id: cluster.id,
      narrative: cluster.threads.map(t => t.summary).join(" "),
      thread_count: cluster.threads.length,
      topics: cluster.threads.map(t => t.topic),
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
