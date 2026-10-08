import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv, settings } from "@/lib/config";
import { embed } from "@/lib/ai";
import { extractText } from "@/lib/cv/extract";
import { parseCv } from "@/lib/cv/parse";
import { classifySimilarity, identityMatches } from "@/lib/cv/dedupe";
import {
  githubHandle,
  linkedinHandle,
  normaliseCvTextForEmbedding,
  normaliseEmail,
  normalisePhoneZA,
  sha256Hex,
} from "@/lib/cv/identity";

/** Quote a value for a PostgREST `or=(...)` filter. */
const q = (v: string) => `"${v.replace(/["\\]/g, "")}"`;

type Identity = { email: string | null; phone: string | null; linkedin: string | null; github: string | null };

export class CvError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * Upload → extract → parse → embed → dedupe flags. Runs with the service-role client,
 * so the caller must have authenticated `userId` already.
 */
export async function processCv(admin: SupabaseClient, userId: string, path: string, fileName: string) {
  if (!path.startsWith(`${userId}/`) || path.includes("..")) throw new CvError("Invalid file path", 403);

  const { data: existing } = await admin.from("cvs").select("id, status").eq("storage_path", path).maybeSingle();
  if (existing) return existing;

  const { data: blob, error: dlErr } = await admin.storage.from("cvs").download(path);
  if (dlErr || !blob) throw new CvError("Uploaded file not found", 404);
  const buf = Buffer.from(await blob.arrayBuffer());
  const mime = path.endsWith(".pdf") ? settings.cv.mimeTypes[0] : settings.cv.mimeTypes[1];
  if (buf.length === 0 || buf.length > settings.cv.maxBytes) throw new CvError("File must be under 5 MB");

  const sha = sha256Hex(buf);
  const { data: row, error: insErr } = await admin
    .from("cvs")
    .insert({ user_id: userId, storage_path: path, file_name: fileName, mime, size_bytes: buf.length, file_sha256: sha })
    .select("id")
    .single();
  if (insErr || !row) throw new CvError(insErr?.message ?? "Could not save CV", 500);
  const cvId: string = row.id;

  // Exact-file dedupe doesn't need parsing, so record it even if parsing fails.
  await flagExactFile(admin, cvId, userId, sha);

  try {
    const text = await extractText(buf, mime);
    const { parsed, model, promptVersion, injectionFlags } = await parseCv({
      text,
      pdfBase64: !text && mime === "application/pdf" ? buf.toString("base64") : undefined,
      fileName,
    });
    const env = serverEnv();
    const embedding = await embed(normaliseCvTextForEmbedding(text || JSON.stringify(parsed)), {
      model: env.OPENROUTER_MODEL_EMBED,
      dimensions: settings.cv.embeddingDimensions,
    });

    const id = parsed.identity ?? {};
    const identity: Identity = {
      email: id.email ? normaliseEmail(id.email) : null,
      phone: id.phone ? normalisePhoneZA(id.phone) : null,
      linkedin: id.linkedin ? linkedinHandle(id.linkedin) : null,
      github: id.github ? githubHandle(id.github) : null,
    };

    const { error: updErr } = await admin
      .from("cvs")
      .update({
        status: "parsed",
        text_extracted: text || null,
        parsed,
        parse_model: model,
        prompt_version: promptVersion,
        injection_flags: injectionFlags,
        embedding: JSON.stringify(embedding),
        embed_model: env.OPENROUTER_MODEL_EMBED,
        id_email: identity.email,
        id_phone: identity.phone,
        id_linkedin: identity.linkedin,
        id_github: identity.github,
      })
      .eq("id", cvId);
    if (updErr) throw new Error(updErr.message);

    if (injectionFlags.includes("prompt_injection")) {
      await admin.from("signals").insert({
        user_id: userId,
        context: "cv",
        kind: "prompt_injection",
        payload: { cv_id: cvId, flags: injectionFlags },
      });
    }

    await flagIdentity(admin, cvId, userId, identity);
    await flagSemantic(admin, cvId, userId, embedding);
    await prefillProfile(admin, userId, parsed, identity);
    return { id: cvId, status: "parsed" as const };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("CV processing failed", { cvId, message });
    await admin.from("cvs").update({ status: "failed", error: message.slice(0, 1000) }).eq("id", cvId);
    return { id: cvId, status: "failed" as const };
  }
}

async function insertFlags(admin: SupabaseClient, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const { error } = await admin
    .from("dedupe_flags")
    .upsert(rows, { onConflict: "cv_id,matched_user_id,kind", ignoreDuplicates: true });
  if (error) console.error("dedupe flag insert failed", error.message);
}

async function flagExactFile(admin: SupabaseClient, cvId: string, userId: string, sha: string) {
  const { data } = await admin.from("cvs").select("id, user_id").eq("file_sha256", sha).neq("user_id", userId);
  await insertFlags(
    admin,
    (data ?? []).map((m) => ({
      cv_id: cvId, user_id: userId, matched_cv_id: m.id, matched_user_id: m.user_id,
      kind: "exact_file", similarity: 1, matched_fields: ["file_sha256"],
    })),
  );
}

async function flagIdentity(admin: SupabaseClient, cvId: string, userId: string, mine: Identity) {
  const ors: string[] = [];
  if (mine.email) ors.push(`id_email.eq.${q(mine.email)}`);
  if (mine.phone) ors.push(`id_phone.eq.${q(mine.phone)}`);
  if (mine.linkedin) ors.push(`id_linkedin.eq.${q(mine.linkedin)}`);
  if (mine.github) ors.push(`id_github.eq.${q(mine.github)}`);

  const matches = new Map<string, { cvId: string | null; fields: Set<string> }>();
  const add = (uid: string, cv: string | null, fields: string[]) => {
    if (!fields.length) return;
    const m = matches.get(uid) ?? { cvId: cv, fields: new Set<string>() };
    m.cvId ??= cv;
    fields.forEach((f) => m.fields.add(f));
    matches.set(uid, m);
  };

  if (ors.length) {
    const { data } = await admin
      .from("cvs")
      .select("id, user_id, id_email, id_phone, id_linkedin, id_github")
      .neq("user_id", userId)
      .or(ors.join(","));
    for (const c of data ?? []) {
      add(c.user_id, c.id, identityMatches(mine, {
        email: c.id_email, phone: c.id_phone, linkedin: c.id_linkedin, github: c.id_github,
      }));
    }
  }

  // Other accounts' own sign-up email / profile phone.
  const pOrs: string[] = [];
  if (mine.email) pOrs.push(`email.eq.${q(mine.email)}`);
  if (mine.phone) pOrs.push(`phone_e164.eq.${q(mine.phone)}`);
  if (pOrs.length) {
    const { data } = await admin.from("profiles").select("user_id, email, phone_e164").neq("user_id", userId).or(pOrs.join(","));
    for (const p of data ?? []) {
      add(p.user_id, null, identityMatches(mine, { email: p.email, phone: p.phone_e164, linkedin: null, github: null }));
    }
  }

  await insertFlags(
    admin,
    [...matches].map(([uid, m]) => ({
      cv_id: cvId, user_id: userId, matched_cv_id: m.cvId, matched_user_id: uid,
      kind: "identity", matched_fields: [...m.fields],
    })),
  );
}

async function flagSemantic(admin: SupabaseClient, cvId: string, userId: string, embedding: number[]) {
  const { data, error } = await admin.rpc("match_cvs", {
    query_embedding: JSON.stringify(embedding),
    exclude_user: userId,
    min_similarity: settings.dedupe.semanticReview,
  });
  if (error) {
    console.error("match_cvs failed", error.message);
    return;
  }
  const best = new Map<string, { cv_id: string; similarity: number }>();
  for (const m of (data ?? []) as { cv_id: string; user_id: string; similarity: number }[]) {
    if ((best.get(m.user_id)?.similarity ?? -1) < m.similarity) best.set(m.user_id, m);
  }
  await insertFlags(
    admin,
    [...best].flatMap(([uid, m]) => {
      const kind = classifySimilarity(m.similarity);
      return kind
        ? [{ cv_id: cvId, user_id: userId, matched_cv_id: m.cv_id, matched_user_id: uid, kind,
             similarity: Math.round(m.similarity * 10000) / 10000 }]
        : [];
    }),
  );
}

/** Fill empty profile fields from the CV; never overwrite what the candidate typed. */
async function prefillProfile(
  admin: SupabaseClient,
  userId: string,
  parsed: { identity?: { full_name?: string | null; city?: string | null; linkedin?: string | null; github?: string | null } | null },
  identity: Identity,
) {
  const { data: p } = await admin.from("profiles").select("*").eq("user_id", userId).single();
  if (!p) return;
  const id = parsed.identity ?? {};
  const patch: Record<string, string> = {};
  if (!p.full_name && id.full_name) patch.full_name = id.full_name.slice(0, 200);
  if (!p.city && id.city) patch.city = id.city.slice(0, 100);
  if (!p.phone_e164 && identity.phone) patch.phone_e164 = identity.phone;
  if (!p.linkedin_url && identity.linkedin) patch.linkedin_url = `https://www.linkedin.com/in/${identity.linkedin}`;
  if (!p.github_url && identity.github) patch.github_url = `https://github.com/${identity.github}`;
  if (Object.keys(patch).length) await admin.from("profiles").update(patch).eq("user_id", userId);
}
