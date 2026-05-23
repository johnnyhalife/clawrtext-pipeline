# Implementation Plan — Terminal & Pipeline

---

## Step 6 — Pipeline: vision-based extraction

Replaces the text extraction + map two-step with a single vision call to Nemotron.
Only tackle after validating Step 5 improvement.

**Conversion command:**
```bash
# PPTX → PDF (all slides)
libreoffice --headless --convert-to pdf --outdir /tmp/output deck.pptx

# PDF → PNGs (one per slide, 150 DPI)
pdftoppm -png -r 150 /tmp/output/deck.pdf /tmp/output/slide
# Output: slide-001.png, slide-002.png etc
```

**TypeScript pattern:**
```typescript
async function pptxToPngs(filePath: string, outDir: string): Promise<string[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  // Step 1: PPTX → PDF
  await execFileAsync("libreoffice", [
    "--headless", "--convert-to", "pdf",
    "--outdir", outDir, filePath
  ]);

  // Step 2: PDF → PNGs
  const pdfPath = path.join(outDir, path.basename(filePath, ".pptx") + ".pdf");
  await execFileAsync("pdftoppm", [
    "-png", "-r", "150", pdfPath,
    path.join(outDir, "slide")
  ]);

  // Return sorted PNG paths
  const files = await fs.readdir(outDir);
  return files
    .filter(f => f.endsWith(".png"))
    .sort()
    .map(f => path.join(outDir, f));
}
```

**Pipeline change:**
- Remove step 2 (text extraction via python-pptx)
- Replace with LibreOffice → pdftoppm → PNG per slide
- Step 3 (map) sends PNG directly to Nemotron vision model
- Single model call replaces extract + map
- Test on one known deck before wiring into production
