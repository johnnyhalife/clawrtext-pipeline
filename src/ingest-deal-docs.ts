/**
 * ingest-deal-docs.ts
 *
 * One chunk per high-value document in a Pipedrive deal Documents folder.
 *
 * Flow:
 *   1. Resolve deal by --deal-id or --deal <opportunity-codename>
 *   2. List the deal's SharePoint Documents folder
 *   3. Skip spreadsheets; prefer PDFs over matching DOCX/PPTX files
 *   4. Convert DOCX/PPTX to PDF when needed, extract text, summarize with Nemotron
 *   5. Embed the summary into chunks(source='deal') and link through chunk_deals
 *
 * Usage:
 *   npx tsx src/ingest-deal-docs.ts --deal-id 2159
 *   npx tsx src/ingest-deal-docs.ts --deal 25-2976-amaryllis --dry-run
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Ollama } from "ollama";

import {
  CLAWRTEX_ROOT,
  credentials,
  MODEL_DEAL_DOCS,
  MODEL_EMBED,
  OLLAMA_URL,
} from "./config.js";
import { db, closeDb } from "./db.js";

const ollama = new Ollama({ host: OLLAMA_URL });

type Deal = {
  id: number;
  title: string;
  opportunity_id: string | null;
  codename: string | null;
  start_date: string | null;
  documents_url: string | null;
};

type DriveItem = {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  webUrl: string;
  parentReference?: { driveId?: string };
  file?: { mimeType?: string };
  "@microsoft.graph.downloadUrl"?: string;
};

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function ext(name: string): string {
  const m = name.toLowerCase().match(/\.([^.]+)$/);
  return m ? `.${m[1]}` : "";
}

function sourceHash(dealId: number, itemId: string): string {
  return createHash("md5").update(`deal-doc:${dealId}:${itemId}`).digest("hex");
}

function normalizeStem(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/\b(signed|final|draft|copy)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parseDealSlug(slug: string): { opportunityId: string; codename: string } {
  const m = slug.match(/^(\d{2}-\d+)-(.+)$/);
  if (!m) throw new Error(`Invalid --deal "${slug}". Expected e.g. 25-2976-amaryllis`);
  return { opportunityId: m[1], codename: m[2] };
}

async function execFile(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  if (stderr?.trim()) console.error(stderr.trim());
  return stdout.trim();
}

async function getAccessToken(): Promise<string> {
  const url = `https://login.microsoftonline.com/${credentials.tenant_id}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json() as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`Auth failed: ${data.error_description ?? JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function graphGet(token: string, url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as { error?: { code: string; message: string } };
  if (data.error) throw new Error(`Graph error: ${data.error.code} — ${data.error.message}`);
  return data;
}

async function resolveDriveId(token: string, site: string): Promise<string> {
  const siteData = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/sites/southworks365.sharepoint.com:/sites/${site}`
  ) as { id: string; displayName: string };

  const drivesData = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/sites/${siteData.id}/drives`
  ) as { value: Array<{ id: string; name: string; driveType: string }> };

  const docLib = drivesData.value.find(d => d.driveType === "documentLibrary");
  if (!docLib) throw new Error(`No document library found on site: ${site}`);
  return docLib.id;
}

function parseSharePointFolderUrl(urlText: string): { site: string; folder: string } {
  const url = new URL(urlText);
  const siteMatch = url.pathname.match(/\/sites\/([^/]+)/);
  if (!siteMatch) throw new Error(`Cannot parse SharePoint site from ${urlText}`);

  const decodedPath = decodeURIComponent(url.pathname);
  const marker = "/Shared Documents/";
  const markerIdx = decodedPath.indexOf(marker);
  if (markerIdx === -1) throw new Error(`Cannot parse Shared Documents path from ${urlText}`);

  return {
    site: siteMatch[1],
    folder: decodedPath.slice(markerIdx + marker.length).replace(/^\/+|\/+$/g, ""),
  };
}

async function listFolder(token: string, driveId: string, folder: string): Promise<DriveItem[]> {
  const encodedFolder = folder.split("/").map(encodeURIComponent).join("/");
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedFolder}:/children` +
    `?$select=id,name,size,lastModifiedDateTime,webUrl,file,@microsoft.graph.downloadUrl&$top=200`;
  const data = await graphGet(token, url) as { value: DriveItem[] };
  return (data.value ?? []).filter(item => item.file);
}

function graphShareId(url: string): string {
  return "u!" + Buffer.from(url)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function listFolderUrl(token: string, folderUrl: string): Promise<DriveItem[]> {
  const shareId = graphShareId(folderUrl);
  const url = `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/children` +
    `?$select=id,name,size,lastModifiedDateTime,webUrl,parentReference,file,@microsoft.graph.downloadUrl&$top=200`;
  const data = await graphGet(token, url) as { value: DriveItem[] };
  return (data.value ?? []).filter(item => item.file);
}

function selectDocuments(items: DriveItem[]): DriveItem[] {
  const supported = new Set([".pdf", ".docx", ".pptx"]);
  const skipped = new Set([".xlsx", ".xlsm", ".xls", ".csv"]);

  const candidates = items.filter(item => {
    const itemExt = ext(item.name);
    if (skipped.has(itemExt)) {
      console.error(`[deal-docs] skip spreadsheet: ${item.name}`);
      return false;
    }
    if (!supported.has(itemExt)) {
      console.error(`[deal-docs] skip unsupported: ${item.name}`);
      return false;
    }
    return true;
  });

  const pdfStems = new Set(candidates.filter(i => ext(i.name) === ".pdf").map(i => normalizeStem(i.name)));
  return candidates.filter(item => {
    const itemExt = ext(item.name);
    if (itemExt === ".pdf") return true;
    const stem = normalizeStem(item.name);
    if (pdfStems.has(stem)) {
      console.error(`[deal-docs] prefer matching PDF over ${item.name}`);
      return false;
    }
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function downloadFile(token: string, item: DriveItem, destPath: string): Promise<void> {
  let url = item["@microsoft.graph.downloadUrl"];
  if (!url) {
    const driveId = item.parentReference?.driveId;
    if (!driveId) throw new Error(`No driveId available for ${item.name}`);
    const data = await graphGet(
      token,
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.id}?$select=@microsoft.graph.downloadUrl`
    ) as { "@microsoft.graph.downloadUrl"?: string };
    url = data["@microsoft.graph.downloadUrl"];
  }
  if (!url) throw new Error(`No download URL for ${item.name}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${item.name}: ${res.status} ${res.statusText}`);

  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), createWriteStream(destPath));
}

async function toPdf(inputPath: string, fileName: string, outDir: string): Promise<string> {
  if (ext(fileName) === ".pdf") return inputPath;

  const soffice = process.env.LIBREOFFICE_BIN ?? "soffice";
  console.error(`[deal-docs] ${ext(fileName)}→pdf: ${fileName}`);
  await execFile(soffice, ["--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath]);

  const pdfPath = resolve(outDir, fileName.replace(/\.[^.]+$/, ".pdf"));
  if (!existsSync(pdfPath)) throw new Error(`LibreOffice did not produce ${pdfPath}`);
  return pdfPath;
}

async function pdfToText(pdfPath: string): Promise<string> {
  const textPath = pdfPath.replace(/\.pdf$/i, ".txt");
  await execFile("pdftotext", ["-layout", pdfPath, textPath]);
  const text = readFileSync(textPath, "utf-8").replace(/\u0000/g, "").trim();
  if (text.length < 50) {
    throw new Error(`Extracted text is too short from ${pdfPath}; document may be scanned/image-only`);
  }
  return text;
}

function buildPrompt(deal: Deal, item: DriveItem, text: string): string {
  return [
    "This document is part of a negotiation for a bespoke software development engagement.",
    "Extract the problem or opportunity being addressed, the proposed solution and technical approach, scope and deliverables, and any other information that helps understand what was proposed to the customer and why.",
    "Write a concise but information-dense summary for retrieval. Preserve concrete technologies, systems, deliverables, dates, constraints, and named stakeholders when present.",
    "",
    `Deal: ${deal.title}`,
    `Opportunity: ${deal.opportunity_id ?? "unknown"}`,
    `Codename: ${deal.codename ?? "unknown"}`,
    `Document: ${item.name}`,
    "",
    "Document text:",
    text.slice(0, 120_000),
  ].join("\n");
}

async function summarizeDocument(deal: Deal, item: DriveItem, text: string): Promise<string> {
  const response = await ollama.chat({
    model: MODEL_DEAL_DOCS,
    think: false,
    messages: [
      { role: "user", content: buildPrompt(deal, item, text) },
    ],
    options: { temperature: 0.1 },
  });

  return response.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function embedText(title: string, body: string): Promise<number[]> {
  const response = await ollama.embeddings({
    model: MODEL_EMBED,
    prompt: `${title}\n\n${body}`,
  });
  return response.embedding;
}

async function resolveDeal(): Promise<Deal> {
  const dealId = arg("deal-id");
  const dealSlug = arg("deal");
  const pool = db();

  let row;
  if (dealId) {
    row = await pool.query(
      `SELECT id, title, opportunity_id, codename, start_date::text, documents_url
       FROM pd_deals
       WHERE id = $1`,
      [Number(dealId)]
    );
  } else if (dealSlug) {
    const parsed = parseDealSlug(dealSlug);
    row = await pool.query(
      `SELECT id, title, opportunity_id, codename, start_date::text, documents_url
       FROM pd_deals
       WHERE opportunity_id = $1 AND codename = $2
       ORDER BY id DESC
       LIMIT 1`,
      [parsed.opportunityId, parsed.codename]
    );
  } else {
    throw new Error("Pass --deal-id <id> or --deal <opportunity-codename>, e.g. --deal 25-2976-amaryllis");
  }

  if (row.rowCount !== 1) throw new Error("Deal not found or not unique");
  const deal = row.rows[0] as Deal;
  if (!deal.documents_url) throw new Error(`Deal ${deal.id} has no documents_url`);
  return deal;
}

async function upsertChunk(deal: Deal, item: DriveItem, summary: string, vector: number[]): Promise<number> {
  const pool = db();
  const hash = sourceHash(deal.id, item.id);
  const vectorStr = `[${vector.join(",")}]`;

  const result = await pool.query<{ id: number }>(
    `INSERT INTO chunks
       (codename, source, deck_name, deck_date, slide_index, body, embedding, hash, source_url, source_page)
     VALUES ($1, 'deal', $2, $3, NULL, $4, $5::vector, $6, $7, NULL)
     ON CONFLICT (hash) DO UPDATE SET
       body = EXCLUDED.body,
       embedding = EXCLUDED.embedding,
       deck_name = EXCLUDED.deck_name,
       deck_date = EXCLUDED.deck_date,
       source_url = EXCLUDED.source_url
     RETURNING id`,
    [
      deal.codename,
      item.name,
      deal.start_date,
      summary,
      vectorStr,
      hash,
      item.webUrl,
    ]
  );

  const chunkId = result.rows[0].id;
  await pool.query(
    `INSERT INTO chunk_deals (chunk_id, deal_id, distance_days)
     VALUES ($1, $2, 0)
     ON CONFLICT (chunk_id, deal_id) DO UPDATE SET distance_days = EXCLUDED.distance_days`,
    [chunkId, deal.id]
  );

  return chunkId;
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const limitArg = arg("limit");
  const limit = limitArg ? Number(limitArg) : undefined;

  const deal = await resolveDeal();
  console.error(`[deal-docs] deal ${deal.id}: ${deal.title}`);

  const { site, folder } = parseSharePointFolderUrl(deal.documents_url!);
  console.error(`[deal-docs] folder: ${site}/${folder}`);
  const token = await getAccessToken();
  const folderItems = await listFolderUrl(token, deal.documents_url!);
  const docs = selectDocuments(folderItems).slice(0, limit);

  console.error(`[deal-docs] selected ${docs.length}/${folderItems.length} files`);
  for (const doc of docs) console.error(`  - ${doc.name}`);

  if (dryRun) return;

  const tmpDir = resolve(CLAWRTEX_ROOT, ".state", ".deal-docs-tmp", String(deal.id));
  mkdirSync(tmpDir, { recursive: true });

  for (const item of docs) {
    const localPath = resolve(tmpDir, item.name);
    console.error(`[deal-docs] downloading: ${item.name} (${(item.size / 1024).toFixed(1)} KB)`);
    await downloadFile(token, item, localPath);

    const pdfPath = await toPdf(localPath, item.name, tmpDir);
    const text = await pdfToText(pdfPath);
    console.error(`[deal-docs] extracted ${text.length} chars from ${item.name}`);

    const summary = await summarizeDocument(deal, item, text);
    const vector = await embedText(item.name, summary);
    const chunkId = await upsertChunk(deal, item, summary, vector);
    console.error(`[deal-docs] ✓ chunk ${chunkId}: ${item.name}`);
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
