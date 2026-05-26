import { QDRANT_URL } from "./config.js";
import type { ExtractedThread, Cluster } from "./types.js";

// ── Qdrant REST helper ────────────────────────────────────────────────────────

async function qdrantFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Qdrant ${method} ${path} → ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Centroid ──────────────────────────────────────────────────────────────────

function centroid(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map(x => x / vectors.length);
}

// ── Greedy threshold clustering ───────────────────────────────────────────────

function clusterByThreshold(
  points: Array<{ thread: ExtractedThread; vector: number[] }>,
  threshold: number = 0.85
): Cluster[] {
  const clusters: Array<{
    threads: ExtractedThread[];
    vectors: number[][];
    centroid: number[];
  }> = [];

  for (const { thread, vector } of points) {
    let bestIdx = -1;
    let bestSim = -1;

    for (let i = 0; i < clusters.length; i++) {
      const sim = cosine(vector, clusters[i].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= threshold) {
      clusters[bestIdx].threads.push(thread);
      clusters[bestIdx].vectors.push(vector);
      clusters[bestIdx].centroid = centroid(clusters[bestIdx].vectors);
    } else {
      clusters.push({
        threads: [thread],
        vectors: [vector],
        centroid: vector,
      });
    }
  }

  clusters.sort((a, b) => b.threads.length - a.threads.length);

  return clusters.map((c, i) => ({
    id: i,
    threads: c.threads,
    centroid: c.centroid,
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function cluster(codename: string): Promise<Cluster[]> {
  const collectionName = `clawrtex-${codename}`;

  console.error(`[cluster] fetching all vectors from '${collectionName}'...`);

  const points: Array<{ thread: ExtractedThread; vector: number[] }> = [];
  let offset: number | null = null;

  do {
    const body: Record<string, unknown> = { limit: 256, with_payload: true, with_vector: true };
    if (offset != null) body.offset = offset;

    const result = await qdrantFetch("POST", `/collections/${collectionName}/points/scroll`, body) as {
      result: {
        points: Array<{
          id: number;
          vector: number[];
          payload: Record<string, unknown>;
        }>;
        next_page_offset: number | null;
      };
    };

    for (const point of result.result.points) {
      const payload = point.payload;
      const thread: ExtractedThread = {
        uid: payload.uid as string,
        codename: payload.codename as string,
        topic: payload.topic as string,
        summary: payload.summary as string,
        decisions: payload.decisions as string[],
        action_items: payload.action_items as string[],
        sentiment: payload.sentiment as ExtractedThread["sentiment"],
        has_external: payload.has_external as boolean,
      };
      points.push({ thread, vector: point.vector });
    }

    offset = result.result.next_page_offset;
  } while (offset != null);

  console.error(`[cluster] ${points.length} points loaded`);

  const clusters = clusterByThreshold(points);

  console.error(`[cluster] ${clusters.length} clusters (threshold=0.72)`);
  clusters.slice(0, 5).forEach(c => {
    console.error(`  cluster ${c.id}: ${c.threads.length} threads — e.g. "${c.threads[0].topic}"`);
  });

  return clusters;
}
