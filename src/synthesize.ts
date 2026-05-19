import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { projectPath, CLAWRTEX_ROOT } from "./config.js";
import type { ClusterNarrative, ExtractedThread, DeltaState } from "./types.js";

// ── Preserve manually-filled fields ──────────────────────────────────────────
// Fields still containing <!-- reconcile --> are auto-generated placeholders.
// Fields where <!-- reconcile --> has been replaced are manually filled — never overwrite.

interface PageFields {
  customer: string;
  period: string;
  engagementLead: string;
  customerRep: string;
  stack: string;
}

const RECONCILE = "<!-- reconcile -->";

function extractField(md: string, label: string): string {
  const match = md.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
  return match ? match[1].trim() : RECONCILE;
}

function loadExistingFields(codename: string): PageFields {
  const p = projectPath(codename);
  if (!existsSync(p)) {
    return {
      customer: RECONCILE,
      period: RECONCILE,
      engagementLead: RECONCILE,
      customerRep: RECONCILE,
      stack: RECONCILE,
    };
  }

  const md = readFileSync(p, "utf-8");
  return {
    customer: extractField(md, "Customer"),
    period: extractField(md, "Period"),
    engagementLead: extractField(md, "Engagement lead"),
    customerRep: extractField(md, "Customer representative"),
    stack: extractField(md, "Stack"),
  };
}

// ── Compute period from extracted threads ─────────────────────────────────────

function loadState(codename: string): DeltaState | null {
  const p = resolve(CLAWRTEX_ROOT, 'state', `${codename}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as DeltaState;
}

function computePeriod(codename: string, existingPeriod: string): string {
  // Don't overwrite a manually-filled period
  if (existingPeriod !== RECONCILE) return existingPeriod;

  const state = loadState(codename);
  if (!state?.earliest || !state?.latest) return RECONCILE;

  const fmt = (iso: string) => iso.slice(0, 7); // 'YYYY-MM'
  const start = fmt(state.earliest);
  const end = fmt(state.latest);
  return start === end ? start : `${start} – ${end}`;
}

// ── Build quotes from external threads ───────────────────────────────────────

function buildQuotes(threads: ExtractedThread[]): string {
  // Quotes are not regenerated from extracted data — they require raw post bodies
  // which are in threads.jsonl, not extracted.jsonl.
  // Placeholder for now; will be wired in synthesize when we add raw thread access.
  return "_Quotes regenerated from thread data — see Sources._";
}

// ── Assemble the page ─────────────────────────────────────────────────────────

function assemblePage(
  codename: string,
  fields: PageFields,
  narratives: ClusterNarrative[],
  threads: ExtractedThread[],
  dl: string
): string {
  // Filter: keep clusters with external signal OR explicit decisions.
  // Pure internal clusters with no decisions are logistics — drop them from the narrative.
  // Fall back to all clusters if filtering leaves nothing (shouldn't happen in practice).
  const signalClusters = narratives.filter(c => c.external_ratio > 0);
  const pool = signalClusters.length > 0 ? signalClusters : narratives;

  const dropped = narratives.length - pool.length;
  if (dropped > 0) {
    console.error(`[synthesize] dropped ${dropped} pure-internal/no-decision clusters from narrative`);
  }

  // Sort: external-heavy clusters first, then by thread count
  const sorted = [...pool].sort((a, b) => {
    const extDiff = b.external_ratio - a.external_ratio;
    if (Math.abs(extDiff) > 0.1) return extDiff; // meaningfully different external ratio
    return b.thread_count - a.thread_count;        // tie-break by size
  });

  // Cap at 8 sections; prefer clusters with >1 thread when we have enough
  const significantClusters = sorted.filter(c => c.thread_count > 1);
  const narrativeBlocks = (significantClusters.length > 0 ? significantClusters : sorted)
    .slice(0, 8)
    .map(c => c.narrative)
    .join("\n\n");

  const now = new Date().toISOString().slice(0, 10);
  const threadCount = threads.length;
  const clusterCount = narratives.length;

  return `# ${codename}
## Identity
- **Customer:** ${fields.customer}
- **Period:** ${fields.period}
- **Engagement lead:** ${fields.engagementLead}
- **Customer representative:** ${fields.customerRep}
- **Stack:** ${fields.stack}

## Narrative
${narrativeBlocks}

## Sources
- threads: ${threadCount} (${clusterCount} clusters)
- dl: ${dl}
- last crawl: ${now}
- generated: ${now}
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function synthesize(
  codename: string,
  narratives: ClusterNarrative[],
  threads: ExtractedThread[],
  dl: string
): Promise<string> {
  console.error(`[synthesize] assembling page for '${codename}'`);
  console.error(`[synthesize] ${narratives.length} cluster narratives, ${threads.length} threads`);

  // Preserve manually-filled fields from existing page
  const fields = loadExistingFields(codename);
  // Compute period from ingest state (respects manually-filled values)
  fields.period = computePeriod(codename, fields.period);
  const manualFields = Object.entries(fields)
    .filter(([, v]) => v !== RECONCILE)
    .map(([k]) => k);
  if (manualFields.length > 0) {
    console.error(`[synthesize] preserving manually-filled fields: ${manualFields.join(", ")}`);
  }

  const page = assemblePage(codename, fields, narratives, threads, dl);

  // Write output
  mkdirSync(resolve(CLAWRTEX_ROOT, "projects"), { recursive: true });
  const outPath = projectPath(codename);
  writeFileSync(outPath, page, "utf-8");
  console.error(`[synthesize] wrote → ${outPath}`);

  return page;
}
