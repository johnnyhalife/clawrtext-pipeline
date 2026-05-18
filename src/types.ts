import { z } from "zod";

// ── Raw crawl types ───────────────────────────────────────────────────────────

export interface Post {
  sender: string;
  received: string;         // ISO 8601
  is_external: boolean;     // true if sender is not @southworks.com
  body: string;             // full text, HTML stripped
}

export interface Thread {
  uid: string;              // "email:<threadId>" — canonical citation key
  codename: string;
  topic: string;
  last_delivered: string;   // ISO 8601
  is_external: boolean;     // true if any post has an external sender
  posts: Post[];
}

// ── Extracted (map output) ────────────────────────────────────────────────────

export const ExtractedThreadSchema = z.object({
  uid: z.string(),
  codename: z.string(),
  topic: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()),
  action_items: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  has_external: z.boolean(),
});

export type ExtractedThread = z.infer<typeof ExtractedThreadSchema>;

// ── Embedded (embed output — stored in Qdrant payload) ────────────────────────

export interface EmbeddedThread extends ExtractedThread {
  vector: number[];
}

// ── Cluster ───────────────────────────────────────────────────────────────────

export interface Cluster {
  id: number;
  threads: ExtractedThread[];
  centroid?: number[];
}

// ── Reduce output ─────────────────────────────────────────────────────────────

export interface ClusterNarrative {
  cluster_id: number;
  narrative: string;
  thread_count: number;
  topics: string[];
}

// ── Delta state ───────────────────────────────────────────────────────────────

export interface DeltaState {
  dl: string;
  codename: string;
  last_fetched: string;     // ISO 8601
  last_count: number;
}
