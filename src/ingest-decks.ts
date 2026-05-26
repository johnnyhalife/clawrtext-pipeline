import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "fs";
import { readdir } from "fs/promises";
import { resolve, dirname, basename as pathBasename } from "path";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import pLimit from "p-limit";

import { CLAWRTEX_ROOT, credentials, statePath } from "./config.js";
import { resolve as resolvePath } from "path";

// ── Registry ──────────────────────────────────────────────────────────────────

interface RegistryEntry {
  codename: string;
  sharepoint?: { site: string; folder: string };
}

function lookupSharePoint(codename: string): { site: string; folder: string } {
  const p = resolvePath(CLAWRTEX_ROOT, "registry.json");
  let entries: RegistryEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(p, "utf-8")) as RegistryEntry[];
  } catch {
    throw new Error(`registry.json not found at ${p}`);
  }
  const entry = entries.find(e => e.codename === codename);
  if (!entry?.sharepoint) {
    throw new Error(
      `No SharePoint config for '${codename}' in ${p}.\n` +
      `Add: { "codename": "${codename}", "sharepoint": { "site": "<site>", "folder": "<folder>" } }`
    );
  }
  return entry.sharepoint;
}
import type { Thread, Post, DeckState, DeckFile } from "./types.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

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

// ── Graph helpers ─────────────────────────────────────────────────────────────

async function graphGet(token: string, url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as { error?: { code: string; message: string } };
  if (data.error) throw new Error(`Graph error: ${data.error.code} — ${data.error.message}`);
  return data;
}

// ── Site + Drive resolution ───────────────────────────────────────────────────

async function resolveDriveId(token: string, site: string): Promise<string> {
  const siteData = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/sites/southworks365.sharepoint.com:/sites/${site}`
  ) as { id: string; displayName: string };

  console.error(`[ingest-decks] site: ${siteData.displayName} (${siteData.id})`);

  const drivesData = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/sites/${siteData.id}/drives`
  ) as { value: Array<{ id: string; name: string; driveType: string }> };

  const docLib = drivesData.value.find(d => d.driveType === "documentLibrary");
  if (!docLib) throw new Error(`No document library found on site: ${site}`);

  return docLib.id;
}

// ── File listing ──────────────────────────────────────────────────────────────

// Files to include: Kick Off, Iteration Reviews, Sprint Reviews
const INCLUDE_PATTERNS = [/iteration/i, /sprint/i, /kick.?off/i];
// Files to exclude regardless of include match
const EXCLUDE_PATTERNS = [/proposal/i, /\biso\b/i, /\bsod\b/i, /\beod\b/i];
// Supported formats
const SUPPORTED_EXTS = new Set([".pptx", ".pdf"]);

function shouldInclude(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXCLUDE_PATTERNS.some(p => p.test(lower))) return false;
  if (!SUPPORTED_EXTS.has(`.${lower.split(".").pop()}`)) return false;
  return INCLUDE_PATTERNS.some(p => p.test(lower));
}

async function listDeckFiles(token: string, driveId: string, folder: string): Promise<DeckFile[]> {
  const encodedFolder = encodeURIComponent(folder);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedFolder}:/children` +
    `?$select=name,id,size,lastModifiedDateTime,file,@microsoft.graph.downloadUrl&$top=200`;

  const data = await graphGet(token, url) as {
    value: Array<{
      name: string;
      id: string;
      size: number;
      lastModifiedDateTime: string;
      file?: object;
      "@microsoft.graph.downloadUrl"?: string;
    }>;
  };

  const files: DeckFile[] = [];
  for (const item of data.value ?? []) {
    if (!item.file) continue; // skip folders
    if (!shouldInclude(item.name)) {
      console.error(`[ingest-decks] skip: ${item.name}`);
      continue;
    }
    files.push({
      name: item.name,
      id: item.id,
      size: item.size,
      lastModified: item.lastModifiedDateTime,
      downloadUrl: item["@microsoft.graph.downloadUrl"] ?? "",
    });
  }

  // Deduplicate: same base name (strip date prefix + extension) — prefer PPTX over PDF
  const byBase = new Map<string, DeckFile>();
  for (const f of files) {
    // Base: strip leading date (YYYY-MM-DD or YYYYMMDD), strip extension
    const base = f.name
      .replace(/^\d{4}-?\d{2}-?\d{2}\s*[-–]\s*/, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .trim();
    const existing = byBase.get(base);
    if (!existing) {
      byBase.set(base, f);
    } else {
      // Prefer PPTX over PDF
      const existingIsPptx = existing.name.toLowerCase().endsWith(".pptx");
      const newIsPptx = f.name.toLowerCase().endsWith(".pptx");
      if (newIsPptx && !existingIsPptx) {
        console.error(`[ingest-decks] dedup: prefer ${f.name} over ${existing.name}`);
        byBase.set(base, f);
      }
    }
  }

  const result = [...byBase.values()].sort((a, b) => a.name.localeCompare(b.name));
  console.error(`[ingest-decks] ${result.length} deck files to process`);
  return result;
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadFile(token: string, driveId: string, fileId: string, destPath: string): Promise<void> {
  // Get fresh download URL via Graph (the @microsoft.graph.downloadUrl expires quickly)
  const data = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${fileId}?$select=@microsoft.graph.downloadUrl`
  ) as { "@microsoft.graph.downloadUrl"?: string };

  const url = data["@microsoft.graph.downloadUrl"];
  if (!url) throw new Error(`No download URL for item ${fileId}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), createWriteStream(destPath));
}

// ── Image generation ────────────────────────────────────────────────────────────

interface SlideImage {
  slideIndex: number;
  pngPath: string;
  md5: string;
}

async function exec(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function fileMd5Sync(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("md5").update(buf).digest("hex");
}

async function generateSlideImages(filePath: string, fileName: string, outDir: string): Promise<SlideImage[]> {
  const ext = fileName.split(".").pop()!.toLowerCase();

  if (ext === "pptx") {
    const pdfName = pathBasename(filePath, ".pptx") + ".pdf";
    const pdfPathInOutDir = resolve(outDir, pdfName);
    // LibreOffice ignores --outdir when path has spaces; it writes next to source
    const pdfPathNextToSource = resolve(dirname(filePath), pdfName);
    console.error(`[ingest-decks] pptx→pdf: ${filePath}`);
    const libreoffice = process.env.LIBREOFFICE_BIN ?? "libreoffice";
    await exec(libreoffice, [
      "--headless", "--convert-to", "pdf",
      "--outdir", outDir, filePath
    ]);
    // Move PDF to outDir if LibreOffice ignored --outdir
    if (!existsSync(pdfPathInOutDir) && existsSync(pdfPathNextToSource)) {
      renameSync(pdfPathNextToSource, pdfPathInOutDir);
      console.error(`[ingest-decks] moved pdf to outDir`);
    }
    filePath = pdfPathInOutDir;
  }

  const pdfPath = filePath;
  console.error(`[ingest-decks] pdf→png: ${pdfPath}`);

  await exec("pdftoppm", [
    "-png", "-r", "150", pdfPath, resolve(outDir, "slide")
  ]);

  const filesList = await readdir(outDir);
  const pngFiles = filesList
    .filter(f => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => a.localeCompare(b));

  const result: SlideImage[] = [];
  for (const f of pngFiles) {
    const pngPath = resolve(outDir, f);
    result.push({
      slideIndex: result.length + 1,
      pngPath,
      md5: fileMd5Sync(pngPath),
    });
  }

  return result;
}

// ── Build Thread from slide image ────────────────────────────────────────────────

function imageSlideToThread(codename: string, deckName: string, deckDate: string, slide: SlideImage): Thread {
  const slugDeck = deckName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const uid = `deck:${codename}:${slugDeck}:slide${slide.slideIndex}`;
  const topic = `${deckName} – Slide ${slide.slideIndex}`;

  // body = md5 of the image — used by threadHash() for cache dedup
  const md5Body = slide.md5.toString();
  const post: Post = {
    sender: "iteration-review",
    received: deckDate,
    is_external: true,
    body: md5Body,
  };

  return {
    uid,
    codename,
    topic,
    last_delivered: deckDate,
    is_external: true,
    posts: [post],
    image_path: slide.pngPath,       // absolute path — no guessing at map time
    deck_filename: deckName,           // original .pptx filename — no reconstruction needed
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

function deckStatePath(codename: string): string {
  return resolve(CLAWRTEX_ROOT, "state", `${codename}-decks.json`);
}

function loadDeckState(codename: string): DeckState {
  const p = deckStatePath(codename);
  if (!existsSync(p)) return { codename, files: {} };
  return JSON.parse(readFileSync(p, "utf-8")) as DeckState;
}

function saveDeckState(codename: string, state: DeckState): void {
  mkdirSync(resolve(CLAWRTEX_ROOT, "state"), { recursive: true });
  writeFileSync(deckStatePath(codename), JSON.stringify(state, null, 2), "utf-8");
}

function fileKey(f: DeckFile): string {
  return createHash("sha256").update(`${f.name}:${f.lastModified}`).digest("hex").slice(0, 16);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function ingestDecks(
  codename: string,
  deckFilter?: string  // exact deck filename e.g. "2024-12-17 - Sprint 1 Review.pptx"
): Promise<Thread[]> {
  const { site, folder } = lookupSharePoint(codename);
  console.error(`[ingest-decks] codename=${codename} site=${site} folder=${folder}`);

  const token = await getAccessToken();
  const driveId = await resolveDriveId(token, site);
  const files = await listDeckFiles(token, driveId, folder);

  if (files.length === 0) {
    throw new Error(`No deck files found in ${site}/${folder} — check folder name and filters`);
  }

  // Single-deck filter: restrict to one file
  const filesToProcess = deckFilter
    ? files.filter(f => f.name === deckFilter)
    : files;

  if (deckFilter && filesToProcess.length === 0) {
    throw new Error(`Deck not found in SharePoint: "${deckFilter}"\nAvailable: ${files.map(f => f.name).join(", ")}`);
  }

  if (deckFilter) {
    console.error(`[ingest-decks] single-deck mode: ${deckFilter}`);
  }

  const state = loadDeckState(codename);
  const tmpDir = resolve(CLAWRTEX_ROOT, "state", ".decks-tmp", codename);
  mkdirSync(tmpDir, { recursive: true });

  const threadsPath = statePath(codename, "threads.jsonl");
  mkdirSync(dirname(threadsPath), { recursive: true });

  // Load existing threads (from a prior deck run) keyed by uid for dedup
  const existingThreads = new Map<string, Thread>();
  if (existsSync(threadsPath)) {
    for (const line of readFileSync(threadsPath, "utf-8").split("\n").filter(Boolean)) {
      try {
        const t = JSON.parse(line) as Thread;
        existingThreads.set(t.uid, t);
      } catch { /* skip */ }
    }
  }

  const limit = pLimit(1); // sequential: LibreOffice can't handle concurrent conversions
  let newThreads = 0;

  await Promise.all(filesToProcess.map(f => limit(async () => {
    const key = fileKey(f);
    const fileNameWithoutExt = f.name.replace(/\.[^.]+$/, "");
    const destPath = resolve(tmpDir, f.name);
    const slideDir = resolve(tmpDir, `${fileNameWithoutExt}-slides`);
    const pngsExist = existsSync(slideDir) && readdirSync(slideDir).some(f => f.endsWith(".png"));

    // Skip if hash matches AND PNGs are on disk — regardless of single-deck mode
    if (state.files[f.name] === key && pngsExist) {
      console.error(`[ingest-decks] cached: ${f.name}`);
      // Still need to rebuild threads with image_path for this deck
      const slideImages = readdirSync(slideDir)
        .filter(f => f.endsWith(".png"))
        .sort()
        .map((png, i) => ({ slideIndex: i + 1, pngPath: resolve(slideDir, png), md5: fileMd5Sync(resolve(slideDir, png)) }));
      const dateFromName = f.name.match(/^(\d{4}-?\d{2}-?\d{2})/)?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") ?? f.lastModified.slice(0, 10);
      const deckDate = `${dateFromName}T00:00:00Z`;
      for (const slide of slideImages) {
        const thread = imageSlideToThread(codename, f.name, deckDate, slide);
        existingThreads.set(thread.uid, thread);
      }
      return;
    }

    console.error(`[ingest-decks] downloading: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    mkdirSync(slideDir, { recursive: true });

    await downloadFile(token, driveId, f.id, destPath);

    // Generate slide images
    const slideImages = await generateSlideImages(destPath, f.name, slideDir);

    if (slideImages.length === 0) {
      console.error(`[ingest-decks] warning: no slides extracted from ${f.name}`);
      return;
    }

    // Derive deck date from lastModified (fallback to filename date prefix)
    const dateFromName = f.name.match(/^(\d{4}-?\d{2}-?\d{2})/)?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") ?? f.lastModified.slice(0, 10);
    const deckDate = `${dateFromName}T00:00:00Z`;

    for (const slide of slideImages) {
      const thread = imageSlideToThread(codename, f.name, deckDate, slide);
      existingThreads.set(thread.uid, thread);
      newThreads++;
    }

    state.files[f.name] = key;
    console.error(`[ingest-decks] generated ${slideImages.length} slide images from ${f.name}`);
  })));

  // Write all threads (existing + new)
  const allThreads = [...existingThreads.values()];
  writeFileSync(threadsPath, allThreads.map(t => JSON.stringify(t)).join("\n") + "\n", "utf-8");
  saveDeckState(codename, state);

  console.error(`[ingest-decks] total: ${allThreads.length} slide-threads (${newThreads} new) → ${threadsPath}`);
  return allThreads;
}
