import { Ollama } from "ollama";
import pLimit from "p-limit";
import { OLLAMA_URL, MODEL_REDUCE } from "./config.js";
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

  return `You are writing a factual narrative paragraph for a section of a software project summary page.

You have been given a cluster of related email threads from the project. Synthesize them into a single coherent narrative paragraph.

Thread summaries:
${summaries}

${decisions.length > 0 ? `Key decisions made:\n${decisions.map(d => `- ${d}`).join("\n")}\n` : ""}
${actionItems.length > 0 ? `Key action items:\n${actionItems.map(a => `- ${a}`).join("\n")}\n` : ""}

Write a single factual paragraph (4-8 sentences) that:
- Describes what this group of threads was about and what happened
- Mentions specific technical work, decisions, or outcomes where they exist
- Uses plain, neutral language — no marketing spin, no adjectives like "excellent" or "successful"
- Is suitable as a section of a client-facing project summary

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
