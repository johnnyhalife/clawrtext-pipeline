import { existsSync, readFileSync } from "fs";
import { Ollama } from "ollama";
import { Pool } from "pg";
import pLimit from "p-limit";
import { createHash } from "crypto";

import {
  OLLAMA_URL,
  MODEL_EMBED,
  EMBED_CONCURRENCY,
  PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD,
  statePath,
} from "./config.js";
import type { ExtractedThread } from "./types.js";

const ollama = new Ollama({ host: OLLAMA_URL });

const VECTOR_SIZE = 4096; // qwen3-embedding:8b actual output dimension

// ── Postgres pool ─────────────────────────────────────────────────────────────

function makePool(): Pool {
  return new Pool({
    host: PG_HOST, port: PG_PORT,
    database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
    max: 5,
  });
}

// ── Embed one thread ──────────────────────────────────────────────────────────

async function embedThread(thread: ExtractedThread): Promise<number[]> {
  const text = `${thread.topic}\n\n${thread.summary}`;
  const response = await ollama.embeddings({ model: MODEL_EMBED, prompt: text });
  return response.embedding;
}

// ── Stable hash for dedup ─────────────────────────────────────────────────────

function threadHash(thread: ExtractedThread): string {
  return createHash("md5").update(`${thread.uid}:${thread.summary}`).digest("hex");
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

  const pool = makePool();

  try {
    // Load existing hashes for this codename — skip already-embedded chunks
    const { rows: existingRows } = await pool.query<{ hash: string }>(
      `SELECT hash FROM chunks WHERE codename = $1 AND hash IS NOT NULL`,
      [codename]
    );
    const existingHashes = new Set(existingRows.map(r => r.hash));
    console.error(`[embed] ${existingHashes.size} chunks already in Postgres`);

    const toEmbed = threads.filter(t => !existingHashes.has(threadHash(t)));
    console.error(`[embed] ${toEmbed.length} threads need embedding`);

    if (toEmbed.length === 0) {
      console.error(`[embed] all threads already embedded — nothing to do`);
      return;
    }

    let done = 0;
    const limit = pLimit(EMBED_CONCURRENCY);

    await Promise.all(
      toEmbed.map(thread =>
        limit(async () => {
          const vector = await embedThread(thread);
          const hash = threadHash(thread);

          // pgvector expects '[x,y,z,...]' string format
          const vectorStr = `[${vector.join(",")}]`;

          await pool.query(
            `INSERT INTO chunks
               (codename, source, deck_name, deck_date, slide_index, body, embedding, hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
             ON CONFLICT (hash) DO NOTHING`,
            [
              thread.codename,
              "decks",
              thread.topic ?? null,
              null,             // deck_date populated during reduce phase (future)
              null,
              thread.summary,
              vectorStr,
              hash,
            ]
          );

          done++;
          if (done % 20 === 0 || done === toEmbed.length) {
            console.error(`[embed] ${done}/${toEmbed.length} embedded`);
          }
        })
      )
    );

    console.error(`[embed] ✓ upserted ${toEmbed.length} chunks into Postgres`);
  } finally {
    await pool.end();
  }
}
