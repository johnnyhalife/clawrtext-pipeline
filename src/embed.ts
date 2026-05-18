import { existsSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { Ollama } from "ollama";
import { QdrantClient } from "@qdrant/js-client-rest";
import pLimit from "p-limit";

import {
  OLLAMA_URL,
  QDRANT_URL,
  CLAWRTEX_ROOT,
  MODEL_EMBED,
  EMBED_CONCURRENCY,
  statePath,
} from "./config.js";
import type { ExtractedThread } from "./types.js";

const ollama = new Ollama({ host: OLLAMA_URL });
const qdrant = new QdrantClient({ url: QDRANT_URL });

const VECTOR_SIZE = 4096; // qwen3-embedding:8b output dimension

// ── Collection management ─────────────────────────────────────────────────────

async function ensureCollection(name: string): Promise<void> {
  try {
    await qdrant.getCollection(name);
    console.error(`[embed] collection '${name}' already exists`);
  } catch {
    console.error(`[embed] creating collection '${name}'...`);
    await qdrant.createCollection(name, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
    });
    console.error(`[embed] collection '${name}' created`);
  }
}

// ── Embed one thread ──────────────────────────────────────────────────────────

async function embedThread(thread: ExtractedThread): Promise<number[]> {
  // Embed topic + summary — this is what we search against
  const text = `${thread.topic}\n\n${thread.summary}`;
  const response = await ollama.embeddings({
    model: MODEL_EMBED,
    prompt: text,
  });
  return response.embedding;
}

// ── Upsert to Qdrant ──────────────────────────────────────────────────────────

// Stable numeric id from uid string
function uidToNumericId(uid: string): number {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function embed(codename: string): Promise<void> {
  const extractedPath = statePath(codename, "extracted.jsonl");
  if (!existsSync(extractedPath)) {
    throw new Error(`extracted.jsonl not found — run map first: ${extractedPath}`);
  }

  const threads: ExtractedThread[] = readFileSync(extractedPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as ExtractedThread);

  console.error(`[embed] ${threads.length} extracted threads to embed`);

  const collectionName = `clawrtex-${codename}`;
  await ensureCollection(collectionName);

  // Check existing points to skip already-embedded threads
  const existingIds = new Set<number>();
  try {
    let offset: number | undefined = undefined;
    do {
      const result = await qdrant.scroll(collectionName, {
        limit: 256,
        offset,
        with_payload: false,
        with_vector: false,
      });
      for (const point of result.points) {
        existingIds.add(point.id as number);
      }
      offset = result.next_page_offset as number | undefined;
    } while (offset != null);
    console.error(`[embed] ${existingIds.size} already in Qdrant`);
  } catch {
    console.error(`[embed] could not scroll existing points, will upsert all`);
  }

  const toEmbed = threads.filter(t => !existingIds.has(uidToNumericId(t.uid)));
  console.error(`[embed] ${toEmbed.length} threads need embedding`);

  if (toEmbed.length === 0) {
    console.error(`[embed] all threads already embedded — nothing to do`);
    return;
  }

  let done = 0;
  const limit = pLimit(EMBED_CONCURRENCY);

  const BATCH_SIZE = 32;
  const batches: ExtractedThread[][] = [];
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    batches.push(toEmbed.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    const points = await Promise.all(
      batch.map(thread =>
        limit(async () => {
          const vector = await embedThread(thread);
          done++;
          if (done % 20 === 0 || done === toEmbed.length) {
            console.error(`[embed] ${done}/${toEmbed.length} embedded`);
          }
          return {
            id: uidToNumericId(thread.uid),
            vector,
            payload: {
              uid: thread.uid,
              codename: thread.codename,
              topic: thread.topic,
              summary: thread.summary,
              decisions: thread.decisions,
              action_items: thread.action_items,
              sentiment: thread.sentiment,
              has_external: thread.has_external,
            },
          };
        })
      )
    );

    await qdrant.upsert(collectionName, { points });
  }

  console.error(`[embed] upserted ${toEmbed.length} points → collection '${collectionName}'`);
}
