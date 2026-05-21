import Handlebars from "handlebars";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../prompts");

// Cache compiled templates in memory — file is read once per process
const cache = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Load and render a prompt file.
 *
 * @param activity  Activity name, e.g. "map-decks"
 * @param role      "system" | "user"
 * @param vars      Handlebars variables to interpolate
 * @param fallback  Optional fallback string if the file is missing
 */
export function renderPrompt(
  activity: string,
  role: "system" | "user",
  vars: Record<string, unknown> = {},
  fallback?: string
): string {
  const key = `${activity}.${role}`;

  if (!cache.has(key)) {
    const filePath = resolve(PROMPTS_DIR, `${key}.prompt`);
    if (!existsSync(filePath)) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Prompt file not found: ${filePath}`);
    }
    const source = readFileSync(filePath, "utf-8");
    cache.set(key, Handlebars.compile(source, { noEscape: true }));
  }

  return cache.get(key)!(vars);
}
