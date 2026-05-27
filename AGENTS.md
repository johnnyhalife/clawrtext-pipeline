# AGENTS.md — clawrtex-pipeline

## Behavioral Guidelines

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

**Minimum code that solves the problem. Nothing speculative.**
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

---

## Run

```
npx tsx src/pipeline.ts --codename <name> --dl <address>
npx tsx src/pipeline.ts --codename <name> --source decks
```

Run with `--phase <phase>` to run a single step or CSV `--phase embed,reduce,synthesize`.
Valid phases: `all|ingest|map|embed|cluster|reduce|synthesize|clean|refresh`.

---

## Architecture at a glance

Single monolith TypeScript app (`src/*.ts`) — no framework, no build step. Run via `tsx`
with ESM (`"type": "module"` in package.json, `.js` extensions on all local imports).

Two data sources:
- **DL** (default): fetches MS Graph group threads & posts (delta-aware), produces `threads.jsonl`
- **Decks**: reads SharePoint doc library (site+folder from `~/clawrtex/registry.json`), downloads PPTX/PDF, extracts slides via python3

Pipeline stages (run in order or specify via `--phase`):
1. **ingest** → threads.jsonl (or slide-threads for decks)
2. **map** → LLM extraction (phi4:14b); writes `extracted.jsonl`
3. **embed** → vectorize with qwen3-embedding:8b, upsert into Qdrant
4. **cluster** → greedy cosine threshold (0.72) clustering from Qdrant
5. **reduce** → LLM narrative synthesis per cluster; writes `narratives.jsonl`
6. **synthesize** → assemble `projects/<codename>.md` identity + narrative
7. **clean** → editorial pass on Narrative section

---

## Config & env

- `models.yaml` — model per stage. Override per-env: `MODEL_MAP`, `MODEL_MAP_DECKS`, `MODEL_EMBED`, `MODEL_REDUCE`, `MODEL_SYNTHESIZE`, `MODEL_CLEAN`.
- `credentials.json` — Azure AD app creds (tenant/client_id/client_secret). Ignored by git.
- `.env` values: `QDRANT_URL`, `OLLAMA_URL`, `CLAWRTEX_ROOT`, `CLAWRTEX_CREDENTIALS`.
- Concurrency (`src/config.ts`): `GRAPH_CONCURRENCY=16`, `MAP_CONCURRENCY=4`, `EMBED_CONCURRENCY=8`, `REDUCE_CONCURRENCY` (env-overridable, default 4).

---

## Data layout

- `~/clawrtex/state/` — per-codename JSONL state (`/.threads/`, `/.extraction/`, `/.narratives/`).
- `~/clawrtex/projects/` — final output pages.
- `~/clawrtex/registry.json` — deck source metadata (codename → SharePoint site+folder).
- `state/<codename>.json` — delta state (dl: last_fetched/earliest/latest; decks: file sha256 map).

---

## Prompt system

Handlebars templates in `prompts/<activity>.<system|user>.prompt`. Loaded by `src/prompts.ts`.

---

## Deck ingest specifics

- Include patterns: `iteration`, `sprint`, `kick.?off` (case-insensitive).
- Exclude patterns: `proposal`, `iso`, `sod`, `eod`.
- Supported exts: `.pptx`, `.pdf`. Dedup strips date prefix (`YYYY-MM-DD title`); prefers PPTX over PDF for same base name.
- Requires `python-pptx` and `pdfminer.six` on PATH (no extra npm deps).

---

## Synthesize quirks

- Manual Identity fields preserved via `<!-- reconcile -->` sentinel: if a field is NOT the sentinel, its value is never overwritten by the pipeline.
- Stack extraction uses only external threads (internal = logistics → phantom tech like K8s/React from unrelated clusters).
- Stack with >12 comma-separated items is treated as hallucination loop and cleared.
- Narrative drops pure-internal/no-decision clusters; falls back to all if filtering produces nothing.

---

## Future plan (backlog.md)

Step 6: vision-based extraction replacing map. PPTX → LibreOffice → PDF → pdftoppm → PNGs → Nemotron vision model. See `backlog.md`.
