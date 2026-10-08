/**
 * Placeholders the generator leaves in candidate-facing files for Chase to fill before a cohort
 * goes live (e.g. the SWE Test 1 starter-repo link). generate.ts fills them from
 * --starter-repo-url / STARTER_REPO_URL; upload.ts refuses to upload a candidate file that still
 * holds one, and the platform's Start check (lib/server/work.ts stageMaterialsProblem) refuses a
 * stage whose README still does.
 */

export const STARTER_REPO_PLACEHOLDER = "STARTER_REPO_URL";
export const MATERIAL_PLACEHOLDERS = [STARTER_REPO_PLACEHOLDER, "HANDOFF_PACK_URL"] as const;
const PLACEHOLDER_RE = new RegExp(`\\b(?:${MATERIAL_PLACEHOLDERS.join("|")})\\b`, "g");

/** Placeholders still present in a text (empty when resolved). */
export function placeholdersIn(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_RE) ?? [])];
}

/** Checks a starter-repo link: an https URL on github.com (the harness reads the repo there). */
export function validStarterRepoUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`starter repo URL is not a URL: "${url}"`);
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.pathname.split("/").filter(Boolean).length < 2) {
    throw new Error(`starter repo URL must be https://github.com/<owner>/<repo>, got "${url}"`);
  }
  return u.toString().replace(/\/+$/, "");
}

/** Replaces the starter-repo placeholder with the real link. */
export function fillStarterRepoUrl(text: string, url: string): string {
  const link = validStarterRepoUrl(url);
  return text.replace(new RegExp(`\\b${STARTER_REPO_PLACEHOLDER}\\b`, "g"), link);
}
