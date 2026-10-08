import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { serverEnv } from "@/lib/config";
import { formatBaseline } from "@/lib/grading";
import { loadPrompt } from "@/lib/prompts";
import { wrapUntrusted } from "@/lib/sanitise";
import { GradingError } from "@/lib/server/grading";

/**
 * Generic baseline (docs/09 §3, docs/10 generic-baseline.v1): the stage brief run through the
 * grader model with no data, once per rubric version. P3 ("non-obvious") and SWE Test 2's
 * answer-key grader compare submissions against it. Stored in rubrics.generic_baseline with a
 * header carrying the prompt version and model. Regenerating it changes grading inputs, so the
 * gold set must be re-run afterwards (CLAUDE.md "Grader changes").
 */

export const BASELINE_PROMPT = { key: "generic-baseline", version: 1 } as const;
const BaselineOutput = z.object({ answer: z.string().trim().min(50).max(8000) });

export interface BaselineResult {
  rubricId: string;
  rubricKey: string;
  version: number;
  model: string;
  promptVersion: string;
  words: number;
}

export async function generateBaseline(admin: SupabaseClient, rubricKey: string, opts: { version?: number } = {}): Promise<BaselineResult> {
  let q = admin.from("rubrics").select("id, key, version").eq("key", rubricKey);
  q = opts.version ? q.eq("version", opts.version) : q.eq("active", true);
  const { data: rubric, error } = await q.order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new GradingError(error.message);
  if (!rubric) throw new GradingError(`Rubric ${rubricKey}${opts.version ? ` v${opts.version}` : ""} not found`, 404);

  const { data: stage, error: sErr } = await admin.from("work_stages").select("key, title, brief_md").eq("rubric_key", rubricKey).limit(1).maybeSingle();
  if (sErr) throw new GradingError(sErr.message);
  if (!stage?.brief_md?.trim()) throw new GradingError(`No stage brief found for rubric ${rubricKey}`, 409);

  const prompt = loadPrompt(BASELINE_PROMPT.key, BASELINE_PROMPT.version);
  const res = await chatJson({
    model: serverEnv().OPENROUTER_MODEL_GRADER,
    system: prompt.system,
    user: `ASSESSMENT: ${stage.title}\n\n${wrapUntrusted("brief", stage.brief_md)}`,
    schema: BaselineOutput,
    promptVersion: prompt.promptVersion,
    temperature: 0.3,
  });
  const stored = formatBaseline(res.data.answer, { prompt_version: res.promptVersion, model: res.model, generated_at: new Date().toISOString() });
  const { error: upErr } = await admin.from("rubrics").update({ generic_baseline: stored }).eq("id", rubric.id);
  if (upErr) throw new GradingError(`could not store the baseline: ${upErr.message}`);

  return {
    rubricId: rubric.id,
    rubricKey: rubric.key,
    version: rubric.version,
    model: res.model,
    promptVersion: res.promptVersion,
    words: res.data.answer.split(/\s+/).filter(Boolean).length,
  };
}
