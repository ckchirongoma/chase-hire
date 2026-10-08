import { settings } from "@/lib/config";
import { emailDedupeKey, githubHandle, linkedinHandle, normalisePhoneZA } from "./identity";

/**
 * Dedupe classification (docs/01 §3). Flags are signals for an admin to resolve;
 * nothing here blocks a candidate.
 */

export type SemanticFlag = "semantic_high" | "semantic_review";

export interface DedupeThresholds {
  semanticHigh: number;
  semanticReview: number;
}

/** Cosine similarity ≥ high → semantic_high; ≥ review (and < high) → semantic_review; else null. */
export function classifySimilarity(
  sim: number,
  t: DedupeThresholds = settings.dedupe,
): SemanticFlag | null {
  if (!Number.isFinite(sim)) return null;
  if (sim >= t.semanticHigh) return "semantic_high";
  if (sim >= t.semanticReview) return "semantic_review";
  return null;
}

export type IdentityField = "email" | "phone" | "linkedin" | "github";

export interface IdentityInput {
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  github?: string | null;
}

const NORMALISERS: Record<IdentityField, (s: string | null | undefined) => string | null> = {
  email: emailDedupeKey,
  phone: normalisePhoneZA,
  linkedin: linkedinHandle,
  github: githubHandle,
};

/** Names of the identity fields whose normalised values match. Null/unusable values never match. */
export function identityMatches(mine: IdentityInput, other: IdentityInput): IdentityField[] {
  return (Object.keys(NORMALISERS) as IdentityField[]).filter((field) => {
    const a = NORMALISERS[field](mine[field]);
    return a !== null && a === NORMALISERS[field](other[field]);
  });
}
