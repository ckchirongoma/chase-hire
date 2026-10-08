import type { StageKey } from "./stages";

/**
 * Google Doc answers (docs/06): candidates write in their own copy of our template and submit
 * its link. Pure and client-safe; the download lives in lib/server/gdoc.ts.
 */

/** Text that must stay in a copy of each template (its first line), so we know it is one. */
export const TEMPLATE_MARKERS: Partial<Record<StageKey, string>> = {
  ba_part1: "CHASE-BA1",
  ba_part2: "CHASE-BA2",
};

export interface StageMaterials {
  /** The instructions Google Doc (view only). */
  instructionsUrl: string | null;
  /** The answer template Google Doc (view only; candidates use its copy link). */
  templateUrl: string | null;
  /** https://docs.google.com/document/d/{id}/copy: Google's "Make a copy" prompt. */
  templateCopyUrl: string | null;
}

/** The document id and a clean link from a Google Docs URL, or null if it isn't one. */
export function parseGoogleDocUrl(v: unknown): { id: string; url: string } | null {
  if (typeof v !== "string") return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/);
  if (!m) return null;
  return { id: m[1], url: `https://docs.google.com/document/d/${m[1]}/edit` };
}

/** Any http(s) link, for the instructions doc (it may be a Google Doc or another page). */
function httpsLink(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Reads work_stages.materials ({instructions_url, template_url}) into links for the page. */
export function parseMaterials(raw: unknown): StageMaterials {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const template = parseGoogleDocUrl(m.template_url);
  return {
    instructionsUrl: httpsLink(m.instructions_url),
    templateUrl: template?.url ?? null,
    templateCopyUrl: template ? `https://docs.google.com/document/d/${template.id}/copy` : null,
  };
}
