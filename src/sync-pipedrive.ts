/**
 * sync-pipedrive.ts
 *
 * Syncs Pipedrive → Postgres in dependency order:
 *   1. pd_labels      (global label registry)
 *   2. pd_orgs        (+ pd_org_labels)
 *   3. pd_persons     (+ pd_person_emails, pd_person_labels)
 *   4. pd_deals       (+ pd_deal_labels, pd_deal_persons)
 *
 * Idempotent — upserts on conflict throughout.
 * Pipedrive v1 API (dealFields, organizationFields, personFields endpoints).
 *
 * Usage:
 *   npx tsx src/sync-pipedrive.ts
 *   npx tsx src/sync-pipedrive.ts --entity orgs        # single entity
 *   npx tsx src/sync-pipedrive.ts --entity persons
 *   npx tsx src/sync-pipedrive.ts --entity deals
 *   npx tsx src/sync-pipedrive.ts --limit 50           # cap records (debug)
 */

import { db, closeDb } from "./db.js";

// ── Config ────────────────────────────────────────────────────────────────────

function getEnv(key: string): string {
  const val = process.env[key];
  if (val) return val;
  throw new Error(`Missing required env var: ${key}`);
}

const API_TOKEN      = getEnv("PIPEDRIVE_API_TOKEN");
const COMPANY_DOMAIN = getEnv("PIPEDRIVE_COMPANY_DOMAIN");
const BASE_URL       = `https://${COMPANY_DOMAIN}.pipedrive.com`;

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const filterEntity = arg("entity"); // orgs | persons | deals | undefined (all)
const limitArg     = arg("limit");
const PAGE_LIMIT   = limitArg ? Number(limitArg) : 500;

// ── Pipedrive v1 fetch helpers ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Raw fetch — returns Response (caller handles status)
async function pdGetRaw(path: string, params: Record<string, string | number> = {}): Promise<Response> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_token", API_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return fetch(url.toString());
}

async function pdGet<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_token", API_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pipedrive API error ${res.status}: ${path}`);
  const json = await res.json() as { success: boolean; data: T; additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } } };
  if (!json.success) throw new Error(`Pipedrive returned success=false for ${path}`);
  return json as T;
}

// Paginated collector — returns all items across pages
async function pdGetAll<T = Record<string, unknown>>(
  path: string,
  extraParams: Record<string, string | number> = {}
): Promise<T[]> {
  const results: T[] = [];
  let start = 0;

  while (true) {
    const resp = await pdGet<{ data: T[]; additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } } }>(
      path, { ...extraParams, limit: PAGE_LIMIT, start }
    );
    const items = (resp as any).data as T[] ?? [];
    results.push(...items);

    const pagination = (resp as any).additional_data?.pagination;
    if (!pagination?.more_items_in_collection) break;
    start = pagination.next_start ?? (start + PAGE_LIMIT);
  }

  return results;
}

// ── Label helpers ─────────────────────────────────────────────────────────────

interface PdFieldOption { id: number | string; label: string; color?: string }
interface PdField { key: string; name: string; field_type: string; options: PdFieldOption[] | null }

// Resolve enum/set option label from a value (numeric id or string)
function resolveLabel(options: PdFieldOption[] | null | undefined, value: unknown): string | null {
  if (!options || value == null || value === "") return null;
  const match = options.find(o => String(o.id) === String(value));
  return match?.label ?? null;
}

// Resolve a set field (comma-separated ids or array) → array of labels
function resolveSetLabels(options: PdFieldOption[] | null | undefined, value: unknown): string[] {
  if (!options || value == null || value === "") return [];
  const ids = Array.isArray(value)
    ? value.map(String)
    : String(value).split(",").map(s => s.trim()).filter(Boolean);
  return ids.map(id => options.find(o => String(o.id) === id)?.label).filter(Boolean) as string[];
}

// ── Phase 1: Sync label registry ──────────────────────────────────────────────

async function syncLabels(): Promise<{
  dealFields: PdField[];
  orgFields: PdField[];
  personFields: PdField[];
}> {
  console.error("[pd:labels] fetching field definitions...");

  const [dealFieldsResp, orgFieldsResp, personFieldsResp] = await Promise.all([
    pdGet<{ data: PdField[] }>("/v1/dealFields"),
    pdGet<{ data: PdField[] }>("/v1/organizationFields"),
    pdGet<{ data: PdField[] }>("/v1/personFields"),
  ]);

  const dealFields   = (dealFieldsResp   as any).data as PdField[];
  const orgFields    = (orgFieldsResp    as any).data as PdField[];
  const personFields = (personFieldsResp as any).data as PdField[];

  const pool = db();
  let count  = 0;

  async function insertLabels(fields: PdField[], entityType: "deal" | "org" | "person") {
    for (const field of fields) {
      if (!field.options) continue;
      for (const opt of field.options) {
        if (typeof opt.id !== "number") continue; // skip string-id system options
        await pool.query(
          `INSERT INTO pd_labels (id, entity_type, name, color)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entity_type, id) DO UPDATE
             SET name = EXCLUDED.name, color = EXCLUDED.color`,
          [opt.id, entityType, opt.label, opt.color ?? null]
        );
        count++;
      }
    }
  }

  await insertLabels(dealFields,   "deal");
  await insertLabels(orgFields,    "org");
  await insertLabels(personFields, "person");

  // Explicitly fetch label_ids options for orgs + deals + persons via dedicated field endpoint.
  // Pipedrive sometimes omits options on the bulk field list when there are many entries.
  // This guarantees the full label registry is captured on every sync run.
  for (const [entity, path] of [
    ["org",    "/v1/organizationFields"],
    ["deal",   "/v1/dealFields"],
    ["person", "/v1/personFields"],
  ] as const) {
    const resp = await pdGet<{ data: PdField[] }>(path);
    const fields = (resp as any).data as PdField[];
    const labelField = fields.find((f: PdField) => f.key === "label_ids" || f.key === "label");
    if (labelField?.options) {
      for (const opt of labelField.options) {
        if (typeof opt.id !== "number") continue;
        await pool.query(
          `INSERT INTO pd_labels (id, entity_type, name, color)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entity_type, id) DO UPDATE
             SET name = EXCLUDED.name, color = EXCLUDED.color`,
          [opt.id, entity, opt.label, opt.color ?? null]
        );
        count++;
      }
    }
  }

  console.error(`[pd:labels] ✓ upserted ${count} label entries`);
  return { dealFields, orgFields, personFields };
}

// ── Phase 2: Sync organizations ───────────────────────────────────────────────

// Field key constants for custom org fields (from live API inventory)
const ORG_FIELD = {
  sector:           "80ce2571487924adddecc16d617398c836d632fa",
  region:           "1f33bcc702c522bff2bf41de325050b110afe045",
  channel:          "0c7ba4c8ab37365fa7467fd8d36f3fecbeaa45eb",
  ownership_status: "cc0d9c35ec540e98a724cd126b8753b597c79f3d",
  year_founded:     "8e95ea17f0fa765305f294107fa383742ec8559a",
  documents_url:    "2952912dffe61bb0385bcf030c9c193bde6b6d1f",
  state:            "57b2d976b837f5b9eb426d3e7a25194362fa08a4",
};

async function syncOrgs(orgFields: PdField[]): Promise<void> {
  console.error("[pd:orgs] fetching organizations...");
  const orgs = await pdGetAll<Record<string, unknown>>("/v1/organizations");
  console.error(`[pd:orgs] fetched ${orgs.length} orgs`);

  const pool = db();

  // Build option lookup maps for orgs
  const fieldMap = new Map(orgFields.map(f => [f.key, f]));

  function resolveOrgEnum(key: string, value: unknown): string | null {
    return resolveLabel(fieldMap.get(key)?.options, value);
  }
  function resolveOrgSet(key: string, value: unknown): number[] {
    const opts = fieldMap.get("label_ids")?.options ?? fieldMap.get("label")?.options ?? [];
    if (!opts || value == null || value === "") return [];
    const ids = Array.isArray(value) ? value.map(Number) : [];
    return ids.filter(id => opts.find(o => Number(o.id) === id));
  }

  let upserted = 0;
  for (const org of orgs) {
    const labelIds: number[] = Array.isArray(org["label_ids"]) ? (org["label_ids"] as number[]) : [];

    await pool.query(
      `INSERT INTO pd_orgs
         (id, name, sector, region, industry, annual_revenue, employee_count,
          ownership_status, year_founded, channel, website, linkedin, state, add_time, update_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         name             = EXCLUDED.name,
         sector           = EXCLUDED.sector,
         region           = EXCLUDED.region,
         industry         = EXCLUDED.industry,
         annual_revenue   = EXCLUDED.annual_revenue,
         employee_count   = EXCLUDED.employee_count,
         ownership_status = EXCLUDED.ownership_status,
         year_founded     = EXCLUDED.year_founded,
         channel          = EXCLUDED.channel,
         website          = EXCLUDED.website,
         linkedin         = EXCLUDED.linkedin,
         state            = EXCLUDED.state,
         update_time      = EXCLUDED.update_time`,
      [
        org["id"],
        org["name"],
        resolveOrgEnum(ORG_FIELD.sector, org[ORG_FIELD.sector]),
        resolveOrgEnum(ORG_FIELD.region, org[ORG_FIELD.region]),
        resolveLabel(fieldMap.get("industry")?.options, org["industry"]),
        resolveLabel(fieldMap.get("annual_revenue")?.options, org["annual_revenue"]),
        org["employee_count"] ?? null,
        resolveOrgEnum(ORG_FIELD.ownership_status, org[ORG_FIELD.ownership_status]),
        org[ORG_FIELD.year_founded] ?? null,
        resolveOrgEnum(ORG_FIELD.channel, org[ORG_FIELD.channel]),
        org["website"] ?? null,
        org["linkedin"] ?? null,
        org[ORG_FIELD.state] ?? null,
        org["add_time"] ?? null,
        org["update_time"] ?? null,
      ]
    );

    // Sync label junction rows
    if (labelIds.length > 0) {
      await pool.query(`DELETE FROM pd_org_labels WHERE org_id = $1`, [org["id"]]);
      for (const lid of labelIds) {
        await pool.query(
          `INSERT INTO pd_org_labels (org_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [org["id"], lid]
        );
      }
    }

    upserted++;
  }

  console.error(`[pd:orgs] ✓ upserted ${upserted} orgs`);
}

// ── Phase 3: Sync persons ─────────────────────────────────────────────────────

const PERSON_FIELD = {
  job_title: "dd75f7df0a72ab80d3f1ce41c8ce1f4dbf10c55b",
  linkedin:  "841d2153a7f639796f1b03319ca0aa67b7fb1cfc",
  source:    "7c6538c4827a2415c859913693bf6518a9395b6c",
  tag:       "be2e9e8ea193fb31b5ed889bdd2e911e23c1d94e",
};

async function syncPersons(personFields: PdField[]): Promise<void> {
  console.error("[pd:persons] fetching persons...");
  const persons = await pdGetAll<Record<string, unknown>>("/v1/persons");
  console.error(`[pd:persons] fetched ${persons.length} persons`);

  const pool = db();
  const fieldMap = new Map(personFields.map(f => [f.key, f]));

  let upserted = 0;
  for (const person of persons) {
    // Extract emails — Pipedrive returns an array of {value, primary, label}
    const emailEntries: Array<{ value: string; primary: boolean; label: string }> =
      Array.isArray(person["email"]) ? (person["email"] as any[]) : [];
    const primaryEmail = emailEntries.find(e => e.primary)?.value
      ?? emailEntries[0]?.value
      ?? null;

    // Primary phone
    const phoneEntries: Array<{ value: string; primary: boolean }> =
      Array.isArray(person["phone"]) ? (person["phone"] as any[]) : [];
    const primaryPhone = phoneEntries.find(e => e.primary)?.value
      ?? phoneEntries[0]?.value
      ?? null;

    const labelIds: number[] = Array.isArray(person["label_ids"]) ? (person["label_ids"] as number[]) : [];

    const orgId = (person["org_id"] as any)?.value ?? person["org_id"] ?? null;

    await pool.query(
      `INSERT INTO pd_persons
         (id, name, first_name, last_name, email, phone, org_id, owner_user_id,
          job_title, linkedin, source, tag, add_time, update_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         name          = EXCLUDED.name,
         first_name    = EXCLUDED.first_name,
         last_name     = EXCLUDED.last_name,
         email         = EXCLUDED.email,
         phone         = EXCLUDED.phone,
         org_id        = EXCLUDED.org_id,
         owner_user_id = EXCLUDED.owner_user_id,
         job_title     = EXCLUDED.job_title,
         linkedin      = EXCLUDED.linkedin,
         source        = EXCLUDED.source,
         tag           = EXCLUDED.tag,
         update_time   = EXCLUDED.update_time`,
      [
        person["id"],
        person["name"],
        person["first_name"] ?? null,
        person["last_name"]  ?? null,
        primaryEmail,
        primaryPhone,
        orgId,
        (person["owner_id"] as any)?.id ?? person["owner_id"] ?? null,
        person[PERSON_FIELD.job_title] ?? null,
        person[PERSON_FIELD.linkedin]  ?? null,
        person[PERSON_FIELD.source]    ?? null,
        resolveLabel(fieldMap.get(PERSON_FIELD.tag)?.options, person[PERSON_FIELD.tag]),
        person["add_time"]    ?? null,
        person["update_time"] ?? null,
      ]
    );

    // Sync email rows
    if (emailEntries.length > 0) {
      await pool.query(`DELETE FROM pd_person_emails WHERE person_id = $1`, [person["id"]]);
      for (const e of emailEntries) {
        if (!e.value) continue;
        await pool.query(
          `INSERT INTO pd_person_emails (person_id, email, label, is_primary)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (person_id, email) DO UPDATE
             SET label = EXCLUDED.label, is_primary = EXCLUDED.is_primary`,
          [person["id"], e.value, e.label ?? null, e.primary ?? false]
        );
      }
    }

    // Sync label junction rows
    if (labelIds.length > 0) {
      await pool.query(`DELETE FROM pd_person_labels WHERE person_id = $1`, [person["id"]]);
      for (const lid of labelIds) {
        await pool.query(
          `INSERT INTO pd_person_labels (person_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [person["id"], lid]
        );
      }
    }

    upserted++;
  }

  console.error(`[pd:persons] ✓ upserted ${upserted} persons`);
}

// ── Phase 4: Sync deals ───────────────────────────────────────────────────────

const DEAL_FIELD = {
  description:    "081541b2a720bd8c9c32d06a673bb67eedd869a5",
  opportunity_id: "d42f539c372596ba80208412d3259607a41f66a7",
  codename:       "00a02c46a8f287a1197f950d6d9f7bf2f4a56650",
  documents_url:  "42fa64b071be2244c7fcb98de6ab57901d544057",
  cloud_provider: "c4bf7a55ee82dcec3f85524cc190ebab5fd0bf8e",
  start_end:      "56dd42484cc1eb404bb8d3f4886ec482671a6c4b",
  end_date:       "56dd42484cc1eb404bb8d3f4886ec482671a6c4b_until",
  contract_type:  "77bea5798bcce4409383fde6b989f87dad30def7",
  supplier:       "0923f43a300573eabb7793ecd2a9a65f875cfbda",
  po_number:      "20c5137de42357965fdf85d6fb96d5291bf90b97",
  sponsor:        "0aa9066cc882060af1ce2fbbe2a78d76c9ebe135",  // org-type field — ignored (deferred to Zoho)
  ext_ref_id:     "082fa4714cb733a159285a6321b39635333ac8b2",
};

async function syncDeals(dealFields: PdField[]): Promise<void> {
  console.error("[pd:deals] fetching deals...");
  const deals = await pdGetAll<Record<string, unknown>>("/v1/deals", { status: "all_not_deleted" });
  console.error(`[pd:deals] fetched ${deals.length} deals`);

  const pool = db();
  const fieldMap = new Map(dealFields.map(f => [f.key, f]));

  const participantQueue: Array<{ dealId: number; primaryPersonId: number | null }> = [];
  let upserted = 0;
  for (const deal of deals) {
    const labelIds: number[] = Array.isArray(deal["label"])
      ? (deal["label"] as number[])
      : deal["label"] != null
        ? String(deal["label"]).split(",").map(Number).filter(n => !isNaN(n))
        : [];

    const orgId    = (deal["org_id"] as any)?.value ?? deal["org_id"] ?? null;
    const personId = (deal["person_id"] as any)?.value ?? deal["person_id"] ?? null;

    await pool.query(
      `INSERT INTO pd_deals
         (id, title, opportunity_id, codename, description, status,
          stage_id, pipeline_id, org_id, owner_user_id,
          value, currency, contract_type, cloud_provider, supplier,
          po_number, ext_ref_id, start_date, end_date, documents_url,
          lost_reason, sponsor_id,
          won_time, lost_time, close_time, add_time, update_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (id) DO UPDATE SET
         title          = EXCLUDED.title,
         opportunity_id = EXCLUDED.opportunity_id,
         codename       = EXCLUDED.codename,
         description    = EXCLUDED.description,
         status         = EXCLUDED.status,
         stage_id       = EXCLUDED.stage_id,
         pipeline_id    = EXCLUDED.pipeline_id,
         org_id         = EXCLUDED.org_id,
         owner_user_id  = EXCLUDED.owner_user_id,
         value          = EXCLUDED.value,
         currency       = EXCLUDED.currency,
         contract_type  = EXCLUDED.contract_type,
         cloud_provider = EXCLUDED.cloud_provider,
         supplier       = EXCLUDED.supplier,
         po_number      = EXCLUDED.po_number,
         ext_ref_id     = EXCLUDED.ext_ref_id,
         start_date     = EXCLUDED.start_date,
         end_date       = EXCLUDED.end_date,
         documents_url  = EXCLUDED.documents_url,
         lost_reason    = EXCLUDED.lost_reason,
         sponsor_id     = EXCLUDED.sponsor_id,
         won_time       = EXCLUDED.won_time,
         lost_time      = EXCLUDED.lost_time,
         close_time     = EXCLUDED.close_time,
         update_time    = EXCLUDED.update_time`,
      [
        deal["id"],
        deal["title"],
        deal[DEAL_FIELD.opportunity_id] ?? null,
        deal[DEAL_FIELD.codename]       ?? null,
        deal[DEAL_FIELD.description]    ?? null,
        deal["status"],
        (deal["stage_id"] as any) ?? null,
        (deal["pipeline_id"] as any) ?? null,
        orgId,
        (deal["user_id"] as any)?.id ?? deal["user_id"] ?? null,
        deal["value"]    ?? null,
        deal["currency"] ?? null,
        resolveLabel(fieldMap.get(DEAL_FIELD.contract_type)?.options,  deal[DEAL_FIELD.contract_type]),
        resolveLabel(fieldMap.get(DEAL_FIELD.cloud_provider)?.options, deal[DEAL_FIELD.cloud_provider]),
        resolveLabel(fieldMap.get(DEAL_FIELD.supplier)?.options,       deal[DEAL_FIELD.supplier]),
        deal[DEAL_FIELD.po_number]  ?? null,
        deal[DEAL_FIELD.ext_ref_id] ?? null,
        deal[DEAL_FIELD.start_end]  ?? null,
        deal[DEAL_FIELD.end_date]   ?? null,
        deal[DEAL_FIELD.documents_url] ?? null,
        deal["lost_reason"] ?? null,
        null, // sponsor_id — deferred FK → zh_customers; always null until Zoho sync
        deal["won_time"]   ?? null,
        deal["lost_time"]  ?? null,
        deal["close_time"] ?? null,
        deal["add_time"]   ?? null,
        deal["update_time"] ?? null,
      ]
    );

    // Sync deal label junction rows
    if (labelIds.length > 0) {
      await pool.query(`DELETE FROM pd_deal_labels WHERE deal_id = $1`, [deal["id"]]);
      for (const lid of labelIds) {
        await pool.query(
          `INSERT INTO pd_deal_labels (deal_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [Number(deal["id"]), lid]
        );
      }
    }

    // Primary contact from deal row
    if (personId) {
      await pool.query(
        `INSERT INTO pd_deal_persons (deal_id, person_id, is_primary)
         VALUES ($1, $2, true)
         ON CONFLICT (deal_id, person_id) DO UPDATE SET is_primary = true`,
        [deal["id"], personId]
      );
    }

    // Additional participants from /v1/deals/{id}/participants
    // Batched: collected and fetched after all deal upserts to avoid serial bottleneck
    participantQueue.push({ dealId: deal["id"] as number, primaryPersonId: personId as number | null });

    upserted++;
  }

  // Fetch participants serially with rate-limit awareness
  // Pipedrive per-deal endpoints have a strict rate limit — serial with backoff is safer than concurrent.
  console.error(`[pd:deals] fetching participants for ${participantQueue.length} deals...`);
  let partFetched = 0;
  let partFailed  = 0;
  for (const { dealId, primaryPersonId } of participantQueue) {
    let attempts = 0;
    while (attempts < 3) {
      try {
        const partResp = await pdGetRaw(`/v1/deals/${dealId}/participants`);
        if (partResp.status === 429) {
          const retryAfter = Number(partResp.headers.get("Retry-After") ?? "2");
          await sleep((retryAfter + 1) * 1000);
          attempts++;
          continue;
        }
        const json = await partResp.json() as { data: Array<{ person_id?: { value: number } }> };
        for (const p of (json.data ?? [])) {
          const pid = p.person_id?.value;
          if (!pid || pid === primaryPersonId) continue;
          await pool.query(
            `INSERT INTO pd_deal_persons (deal_id, person_id, is_primary)
             VALUES ($1, $2, false)
             ON CONFLICT (deal_id, person_id) DO NOTHING`,
            [dealId, pid]
          );
        }
        partFetched++;
        break;
      } catch (e) {
        console.error(`[pd:deals] warn: participants fetch failed for deal ${dealId}: ${e}`);
        partFailed++;
        break;
      }
    }
    // Throttle: 2 req/s stays well within Pipedrive's rate limits
    await sleep(500);
  }
  console.error(`[pd:deals] participants: ${partFetched} fetched, ${partFailed} failed`);

  console.error(`[pd:deals] ✓ upserted ${upserted} deals`);
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error(`[sync-pipedrive] starting — entity=${filterEntity ?? "all"}`);

  const { dealFields, orgFields, personFields } = await syncLabels();

  if (!filterEntity || filterEntity === "orgs") {
    await syncOrgs(orgFields);
  }
  if (!filterEntity || filterEntity === "persons") {
    await syncPersons(personFields);
  }
  if (!filterEntity || filterEntity === "deals") {
    await syncDeals(dealFields);
  }

  console.error("[sync-pipedrive] done.");
}

run().catch(e => {
  console.error("[sync-pipedrive] fatal:", e);
  process.exit(1);
}).finally(closeDb);
