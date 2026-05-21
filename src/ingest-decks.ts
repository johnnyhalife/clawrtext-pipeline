import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import pLimit from "p-limit";

import { CLAWRTEX_ROOT, credentials, statePath } from "./config.js";
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

// ── PPTX slide extraction ─────────────────────────────────────────────────────

interface RawSlide {
  slideIndex: number;
  title: string;
  body: string;
}

async function extractPptxSlides(filePath: string): Promise<RawSlide[]> {
  // Use python-pptx via a small inline Python script — no extra npm deps
  const script = `
import sys, json
from pptx import Presentation
from pptx.enum.shapes import PP_PLACEHOLDER

path = sys.argv[1]
prs = Presentation(path)
slides = []

for i, slide in enumerate(prs.slides):
    texts = []
    title = ""
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        t = shape.text_frame.text.strip()
        if not t:
            continue
        # Safely detect title placeholder without raising on non-placeholders
        is_title = False
        try:
            pf = shape.placeholder_format
            if pf is not None and pf.idx == 0:
                is_title = True
        except Exception:
            pass
        if is_title:
            title = t
        else:
            texts.append(t)
    body = "\\n".join(texts)
    if title or body:
        slides.append({"slideIndex": i + 1, "title": title, "body": body})

print(json.dumps(slides))
`;

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, filePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as RawSlide[];
  } catch (err) {
    console.error(`[ingest-decks] pptx parse failed for ${filePath}: ${err}`);
    return [];
  }
}

// ── PDF slide extraction ──────────────────────────────────────────────────────

async function extractPdfSlides(filePath: string): Promise<RawSlide[]> {
  // Use pdfminer.six for text extraction, one page = one slide
  const script = `
import sys, json
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

path = sys.argv[1]
slides = []
for i, page in enumerate(extract_pages(path)):
    texts = []
    for element in page:
        if isinstance(element, LTTextContainer):
            t = element.get_text().strip()
            if t:
                texts.append(t)
    body = "\\n".join(texts)
    if body:
        slides.append({"slideIndex": i + 1, "title": f"Page {i + 1}", "body": body})

print(json.dumps(slides))
`;

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, filePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as RawSlide[];
  } catch (err) {
    console.error(`[ingest-decks] pdf parse failed for ${filePath}: ${err}`);
    return [];
  }
}

// ── Build Thread from slide ───────────────────────────────────────────────────

function slideToThread(codename: string, deckName: string, deckDate: string, slide: RawSlide): Thread {
  const slugDeck = deckName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const uid = `deck:${codename}:${slugDeck}:slide${slide.slideIndex}`;
  const topic = slide.title || `${deckName} – Slide ${slide.slideIndex}`;
  const body = [slide.title ? `# ${slide.title}` : "", slide.body].filter(Boolean).join("\n\n");

  const post: Post = {
    sender: "iteration-review",
    received: deckDate,
    is_external: true, // decks are customer-facing by definition
    body,
  };

  return {
    uid,
    codename,
    topic,
    last_delivered: deckDate,
    is_external: true,
    posts: [post],
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
  site: string,
  folder: string
): Promise<Thread[]> {
  console.error(`[ingest-decks] codename=${codename} site=${site} folder=${folder}`);

  const token = await getAccessToken();
  const driveId = await resolveDriveId(token, site);
  const files = await listDeckFiles(token, driveId, folder);

  if (files.length === 0) {
    throw new Error(`No deck files found in ${site}/${folder} — check folder name and filters`);
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

  const limit = pLimit(3); // 3 concurrent downloads
  let newThreads = 0;

  await Promise.all(files.map(f => limit(async () => {
    const key = fileKey(f);
    if (state.files[f.name] === key) {
      console.error(`[ingest-decks] cached: ${f.name}`);
      return;
    }

    console.error(`[ingest-decks] downloading: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    const ext = f.name.split(".").pop()!.toLowerCase();
    const destPath = resolve(tmpDir, f.name);

    await downloadFile(token, driveId, f.id, destPath);

    // Extract slides
    const slides = ext === "pptx"
      ? await extractPptxSlides(destPath)
      : await extractPdfSlides(destPath);

    if (slides.length === 0) {
      console.error(`[ingest-decks] warning: no slides extracted from ${f.name}`);
      return;
    }

    // Derive deck date from lastModified (fallback to filename date prefix)
    const dateFromName = f.name.match(/^(\d{4}-?\d{2}-?\d{2})/)?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") ?? f.lastModified.slice(0, 10);
    const deckDate = `${dateFromName}T00:00:00Z`;

    for (const slide of slides) {
      const thread = slideToThread(codename, f.name, deckDate, slide);
      existingThreads.set(thread.uid, thread);
      newThreads++;
    }

    state.files[f.name] = key;
    console.error(`[ingest-decks] extracted ${slides.length} slides from ${f.name}`);
  })));

  // Write all threads (existing + new)
  const allThreads = [...existingThreads.values()];
  writeFileSync(threadsPath, allThreads.map(t => JSON.stringify(t)).join("\n") + "\n", "utf-8");
  saveDeckState(codename, state);

  console.error(`[ingest-decks] total: ${allThreads.length} slide-threads (${newThreads} new) → ${threadsPath}`);
  return allThreads;
}
