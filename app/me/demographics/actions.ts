"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { DEMOGRAPHICS_NOTICE_VERSION, DISABILITY, GENDERS, POPULATION_GROUPS } from "./notice";

/**
 * Optional demographics (docs/12, docs/09 §9). Writes go through the candidate's own client, so
 * RLS (owner only) applies; nobody else, admins included, can read or change the row.
 */

const values = <T extends readonly { value: string }[]>(opts: T) => opts.map((o) => o.value) as [T[number]["value"], ...T[number]["value"][]];
const optional = <T extends [string, ...string[]]>(allowed: T) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(allowed).nullable());

const Save = z
  .object({
    consent: z.literal("on", { error: "Tick the box to agree to the separate consent first." }),
    population_group: optional(values(POPULATION_GROUPS)),
    gender: optional(values(GENDERS)),
    disability: optional(values(DISABILITY)),
  })
  .refine((d) => d.population_group || d.gender || d.disability, { message: "Answer at least one question, or leave the page." });

const go = (params: Record<string, string>): never => redirect(`/me/demographics?${new URLSearchParams(params)}`);

export async function saveDemographics(formData: FormData) {
  const { supabase, user } = await requireUser("/me/demographics");
  const parsed = Save.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go({ error: parsed.error.issues[0].message });
  const { population_group, gender, disability } = parsed.data!;
  const { error } = await supabase.from("demographics").upsert(
    {
      user_id: user.id,
      population_group,
      gender,
      disability,
      notice_version: DEMOGRAPHICS_NOTICE_VERSION,
      consented_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) go({ error: "We couldn't save your answers. Please try again." });
  go({ ok: "saved" });
}

export async function deleteDemographics() {
  const { supabase, user } = await requireUser("/me/demographics");
  const { error } = await supabase.from("demographics").delete().eq("user_id", user.id);
  if (error) go({ error: "We couldn't delete your answers. Please try again." });
  go({ ok: "deleted" });
}
