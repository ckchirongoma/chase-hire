import fs from "node:fs";
import path from "node:path";

/**
 * Loads a versioned prompt from `prompts/<key>.v<version>.md`.
 *
 * File format:
 *   ---
 *   key: cv-parser
 *   version: 1
 *   ---
 *   <system prompt body>
 *
 * The header must match the requested key and version, so a renamed or copied file can never
 * silently serve the wrong prompt. `promptVersion` (e.g. "cv-parser.v1") is stored on every AI output.
 */
export interface LoadedPrompt {
  system: string;
  promptVersion: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

export function loadPrompt(key: string, version: number): LoadedPrompt {
  if (!KEY_RE.test(key)) throw new Error(`loadPrompt: invalid prompt key "${key}"`);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`loadPrompt: invalid prompt version "${version}"`);
  }

  const promptVersion = `${key}.v${version}`;
  const file = path.join(process.cwd(), "prompts", `${promptVersion}.md`);
  const raw = fs.readFileSync(file, "utf8");

  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`loadPrompt: ${promptVersion}.md has no front-matter header`);

  const header: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (kv) header[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }

  if (header.key !== key || Number(header.version) !== version) {
    throw new Error(
      `loadPrompt: header mismatch in ${promptVersion}.md (found key=${header.key ?? "?"}, version=${header.version ?? "?"})`,
    );
  }

  const system = match[2].trim();
  if (!system) throw new Error(`loadPrompt: ${promptVersion}.md has an empty body`);

  return { system, promptVersion };
}
