import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Server actions and pages run as whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { purgeNow } from "@/app/admin/compliance/actions";
import { recomputeItemStats } from "@/app/admin/banks/actions";
import { deleteDemographics, saveDemographics } from "@/app/me/demographics/actions";
import { DEMOGRAPHICS_NOTICE_VERSION } from "@/app/me/demographics/notice";
import { adverseImpactAll, adverseImpact, demographicsCoverage, reliability, retentionOverview } from "@/lib/server/compliance";
import { anon, consent, makeAdmin, newUser as newUserRaw, psql, service } from "../helpers/local";

const admin = service();

/** Every account this file creates, removed afterwards so repeated runs don't grow the shared DB. */
const created: string[] = [];
async function newUser(tag: string) {
  const u = await newUserRaw(tag);
  created.push(u.id);
  return u;
}
afterAll(() => {
  if (!created.length) return;
  const ids = created.map((id) => `'${id}'`).join(",");
  // Candidates first: an admin can't go while their decisions (on those candidates) exist.
  psql(`delete from auth.users u where u.id in (${ids}) and not exists (select 1 from public.admins a where a.user_id = u.id);
        delete from auth.users where id in (${ids});`);
});

function seed(sql: string) {
  psql(`set session_replication_role = replica; ${sql}`);
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
/** Runs a server action and returns where it sent the browser ("404" for notFound). */
async function outcome(action: Promise<unknown>): Promise<URL | "404"> {
  try {
    await action;
  } catch (err) {
    const digest = String((err as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT;")) return new URL(digest.split(";").slice(2, -2).join(";"), "http://localhost");
    if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return "404";
    throw err;
  }
  throw new Error("the action returned without redirecting");
}
const param = (r: URL | "404", key: string) => (r === "404" ? "404" : r.searchParams.get(key));

let boss: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => {
  boss = await newUser("compliance-admin");
  await makeAdmin(boss.id);
});

/** Creates confirmed users without signing them in (fast); returns their ids. */
async function bulkUsers(tag: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 15) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(15, n - i) }, async (_, j) => {
        const { data, error } = await admin.auth.admin.createUser({
          email: `${tag}.${Date.now()}.${i + j}.${randomUUID().slice(0, 6)}@example.co.za`,
          password: "test-password-123",
          email_confirm: true,
        });
        if (error || !data.user) throw error ?? new Error("createUser failed");
        return data.user.id;
      }),
    );
    ids.push(...batch);
  }
  return ids;
}

describe("adverse impact report (docs/09 §9)", () => {
  const slug = `ai-test-${randomUUID().slice(0, 8)}`;
  let roleId: string;
  let seeded: string[] = [];

  // Test data only: remove the 75 seeded people (cascades their applications, decisions and
  // demographics) and the role, so repeated runs don't grow the shared database.
  afterAll(() => {
    if (seeded.length) psql(`delete from auth.users where id in (${seeded.map((id) => `'${id}'`).join(",")});`);
    if (roleId) psql(`delete from public.roles where id = '${roleId}';`);
  });

  beforeAll(async () => {
    const { data, error } = await admin
      .from("roles")
      .insert({ slug, title: "Adverse impact test role", summary: "Test only.", salary_min: 1, salary_max: 1, active: false })
      .select("id")
      .single();
    if (error) throw error;
    roleId = data.id as string;

    // Gender at the quiz stage, decided by an admin:
    //   female 32 (24 advanced = .75), male 30 (12 advanced = .40, ratio .53: flagged),
    //   non-binary 4 and not disclosed 6 (both under 30: hidden).
    // Plus three female applications that must not count: two only held, one undecided.
    const groups: { gender: string | null; n: number; advanced: number }[] = [
      { gender: "female", n: 32, advanced: 24 },
      { gender: "male", n: 30, advanced: 12 },
      { gender: "non_binary", n: 4, advanced: 4 },
      { gender: null, n: 6, advanced: 1 },
    ];
    const total = groups.reduce((a, g) => a + g.n, 0) + 3;
    const ids = await bulkUsers("ai", total);
    seeded = ids;
    const sql: string[] = [];
    let k = 0;
    const reason = "Test setup: decided on the quiz topic scores and the evidence.";
    for (const g of groups) {
      for (let i = 0; i < g.n; i++, k++) {
        const uid = ids[k];
        const app = randomUUID();
        const adv = i < g.advanced;
        if (g.gender) sql.push(`insert into public.demographics (user_id, gender) values ('${uid}', '${g.gender}');`);
        sql.push(`insert into public.applications (id, user_id, role_id, stage, status) values ('${app}', '${uid}', '${roleId}', '${adv ? "work_1" : "quiz"}', '${adv ? "advanced" : "rejected"}');`);
        if (g.gender === "female" && i === 0) {
          // Rejected first, then advanced on review: the latest decision counts.
          sql.push(`insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at) values ('${app}', 'quiz', 'reject', '${reason}', '${boss.id}', now() - interval '2 hours');`);
        }
        sql.push(`insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at) values ('${app}', 'quiz', '${adv ? "advance" : "reject"}', '${reason}', '${boss.id}', now() - interval '1 hour');`);
        // An earlier stage's decision must not leak into the quiz report.
        sql.push(`insert into public.decisions (application_id, stage, decision, reason, decided_by) values ('${app}', 'interview', 'advance', '${reason}', '${boss.id}');`);
      }
    }
    for (let i = 0; i < 3; i++, k++) {
      const uid = ids[k];
      const app = randomUUID();
      sql.push(`insert into public.demographics (user_id, gender) values ('${uid}', 'female');`);
      sql.push(`insert into public.applications (id, user_id, role_id, stage, status) values ('${app}', '${uid}', '${roleId}', 'quiz', 'awaiting_review');`);
      if (i < 2) sql.push(`insert into public.decisions (application_id, stage, decision, reason, decided_by) values ('${app}', 'quiz', 'hold', '${reason}', '${boss.id}');`);
    }
    seed(sql.join("\n"));
  }, 60_000);

  it("reports decided applications per group, hides groups under 30 and flags the four-fifths breach", async () => {
    const r = await adverseImpact(boss.client, "quiz", "gender", { role: slug });
    expect(r.rows.map((x) => [x.group, x.candidates, x.advanced])).toEqual([
      ["female", 32, 24],
      ["male", 30, 12],
    ]);
    expect(r.hidden.sort()).toEqual(["non_binary", "not_disclosed"]);
    expect(r.reference).toEqual({ group: "female", rate: 0.75 });
    expect(r.flagged).toEqual(["male"]);
    const male = r.rows.find((x) => x.group === "male")!;
    expect(male.ratio).toBeCloseTo(0.4 / 0.75, 10);
    expect(r.decided).toBe(62);

    // The earlier stage: everyone advanced at the interview, so nobody is flagged there.
    const interview = await adverseImpact(boss.client, "interview", "gender", { role: slug });
    expect(interview.flagged).toEqual([]);
    expect(interview.rows.find((x) => x.group === "female")).toMatchObject({ candidates: 32, advanced: 32 });
  });

  it("never returns counts for a group under 30, whatever minimum is asked for", async () => {
    const { data, error } = await boss.client.rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "gender", p_min_n: 2, p_role_slug: slug });
    expect(error).toBeNull();
    const nb = (data as { grp: string; candidates: number | null; suppressed: boolean }[]).find((x) => x.grp === "non_binary");
    expect(nb).toMatchObject({ candidates: null, suppressed: true });
  });

  it("filters by cohort window and role", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const later = await adverseImpact(boss.client, "quiz", "gender", { role: slug, from: tomorrow });
    expect(later.rows).toEqual([]);
    expect(later.hidden).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    const now = await adverseImpact(boss.client, "quiz", "gender", { role: slug, from: today, to: today });
    expect(now.flagged).toEqual(["male"]);
  });

  it("is admin-only, and rejects unknown stages and dimensions", async () => {
    const cand = await newUser("ai-cand");
    const { error } = await cand.client.rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "gender" });
    expect(error?.message).toMatch(/admin_only/);
    const { error: anonErr } = await anon().rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "gender" });
    expect(anonErr).not.toBeNull();
    const { error: dimErr } = await boss.client.rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "age" });
    expect(dimErr?.message).toMatch(/invalid_dimension/);
    const { error: stageErr } = await boss.client.rpc("adverse_impact_report", { p_stage: "x; drop table", p_dimension: "gender" });
    expect(stageErr?.message).toMatch(/invalid_stage/);
  });
});

describe("demographics (separate consent, owner only)", () => {
  it("only the owner can read, change or delete their answers; admins see aggregates only", async () => {
    const a = await newUser("demo-a");
    const b = await newUser("demo-b");
    await consent(a.client);
    await consent(b.client);

    const { error: insErr } = await a.client.from("demographics").insert({ population_group: "coloured", gender: "male", disability: "prefer_not" });
    expect(insErr).toBeNull();
    const own = await a.client.from("demographics").select("population_group, gender, disability");
    expect(own.data).toEqual([{ population_group: "coloured", gender: "male", disability: "prefer_not" }]);

    // Another candidate.
    expect((await b.client.from("demographics").select("*").eq("user_id", a.id)).data).toEqual([]);
    const upd = await b.client.from("demographics").update({ gender: "female" }).eq("user_id", a.id).select();
    expect(upd.data ?? []).toEqual([]);
    const del = await b.client.from("demographics").delete().eq("user_id", a.id).select();
    expect(del.data ?? []).toEqual([]);
    const forged = await b.client.from("demographics").insert({ user_id: a.id, gender: "female" });
    expect(forged.error).not.toBeNull();

    // An admin: no row-level access at all, not even to read.
    expect((await boss.client.from("demographics").select("*").eq("user_id", a.id)).data).toEqual([]);
    const adminUpd = await boss.client.from("demographics").update({ gender: "female" }).eq("user_id", a.id).select();
    expect(adminUpd.data ?? []).toEqual([]);
    // The public.
    expect((await anon().from("demographics").select("*")).data ?? []).toEqual([]);

    expect(psql(`select gender from public.demographics where user_id = '${a.id}'`).trim()).toBe("male");

    // Admins get totals only.
    const cov = await demographicsCoverage(boss.client);
    expect(cov.candidates).toBeGreaterThanOrEqual(2);
    expect(cov.respondents).toBeGreaterThanOrEqual(1);
    expect(cov.dimensions.map((d) => d.dimension)).toEqual(["disability", "gender", "population_group"]);
    expect(Object.keys(cov.dimensions[0]).sort()).toEqual(["dimension", "disclosed", "notAnswered", "preferNot"]);
    const { error: candCov } = await a.client.rpc("demographics_coverage");
    expect(candCov?.message).toMatch(/admin_only/);

    // The owner can change and delete.
    expect((await a.client.from("demographics").update({ gender: "prefer_not" }).eq("user_id", a.id).select()).data).toHaveLength(1);
    expect((await a.client.from("demographics").delete().eq("user_id", a.id).select()).data).toHaveLength(1);
    expect(psql(`select count(*) from public.demographics where user_id = '${a.id}'`).trim()).toBe("0");
  });

  it("the form saves through the candidate's own client with the consent version, and deletes", async () => {
    const c = await newUser("demo-form");
    await consent(c.client);
    h.client = c.client;

    expect(param(await outcome(saveDemographics(form({ gender: "female" }))), "error")).toMatch(/consent/);
    expect(param(await outcome(saveDemographics(form({ consent: "on" }))), "error")).toMatch(/at least one/);
    expect(param(await outcome(saveDemographics(form({ consent: "on", gender: "robot" }))), "error")).not.toBeNull();

    const saved = await outcome(saveDemographics(form({ consent: "on", population_group: "african", gender: "", disability: "no" })));
    expect(param(saved, "ok")).toBe("saved");
    const row = psql(`select population_group || '|' || coalesce(gender, 'null') || '|' || disability || '|' || notice_version from public.demographics where user_id = '${c.id}'`).trim();
    expect(row).toBe(`african|null|no|${DEMOGRAPHICS_NOTICE_VERSION}`);

    // Update in place (one row per person).
    await outcome(saveDemographics(form({ consent: "on", population_group: "prefer_not", gender: "female" })));
    expect(psql(`select population_group || '|' || gender || '|' || coalesce(disability, 'null') from public.demographics where user_id = '${c.id}'`).trim()).toBe(
      "prefer_not|female|null",
    );

    expect(param(await outcome(deleteDemographics()), "ok")).toBe("deleted");
    expect(psql(`select count(*) from public.demographics where user_id = '${c.id}'`).trim()).toBe("0");
  });
});

describe("reliability (KR-20)", () => {
  it("computes KR-20 per form and cohort from the anonymised archive", async () => {
    // 8 people x 6 items with a known KR-20 of .7269 (tests/unit/stats/kr20.test.ts), under a
    // form name of its own so other data can't mix in.
    const matrix = [
      [1, 1, 0, 1, 1, 0],
      [1, 0, 0, 1, 0, 0],
      [1, 1, 1, 1, 1, 1],
      [0, 0, 0, 1, 0, 0],
      [1, 1, 1, 0, 1, 0],
      [1, 1, 0, 1, 1, 1],
      [0, 1, 0, 0, 0, 0],
      [1, 1, 1, 1, 0, 1],
    ];
    const formName = `test-${randomUUID().slice(0, 8)}`;
    const rows = matrix.flatMap((person) => {
      const ref = randomUUID();
      const score = person.reduce((a, b) => a + b, 0);
      return person.map(
        (x, j) => `('reasoning', '${ref}', '${formName}', ${j + 1}, ${x === 1}, true, ${score}, '2026-09-01')`,
      );
    });
    psql(`insert into public.item_response_archive (source, attempt_ref, form, position, correct, served, attempt_score, cohort_month) values ${rows.join(",")};`);
    try {
      const rel = await reliability(boss.client);
      const mine = rel.filter((r) => r.form === formName);
      expect(mine.map((r) => r.cohort)).toEqual([null, "2026-09-01"]);
      for (const r of mine) {
        expect(r).toMatchObject({ attempts: 8, k: 6, mean: 3.5, band: "too_few" });
        expect(r.kr20).toBeCloseTo(0.726923, 5);
      }
    } finally {
      psql(`delete from public.item_response_archive where form = '${formName}';`);
    }

    // RLS: a candidate gets nothing.
    const cand = await newUser("kr20-cand");
    const { data, error } = await cand.client.rpc("reasoning_kr20_inputs");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("admin pages and actions", () => {
  it("purge now needs an admin, the tick box and the exact number due", async () => {
    const cand = await newUser("purge-cand");
    h.client = cand.client;
    expect(await outcome(purgeNow(form({ confirm: "0", ack: "on" })))).toBe("404");

    h.client = boss.client;
    expect(param(await outcome(purgeNow(form({ confirm: "1" }))), "error")).toMatch(/Tick the box/);
    const wrong = await outcome(purgeNow(form({ confirm: "987654", ack: "on" })));
    expect(param(wrong, "error")).toMatch(/Confirm the exact number|Nobody is due/);
    expect(param(wrong, "ok")).toBeNull();
  });

  it("the compliance data loads for an admin and is refused to anyone else", async () => {
    const [overview, impact] = await Promise.all([retentionOverview(boss.client), adverseImpactAll(boss.client)]);
    expect(overview.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview.queued).toBeGreaterThanOrEqual(overview.dueNow);
    expect(Array.isArray(overview.log)).toBe(true);
    expect(impact).toHaveLength(8 * 3);
    for (const r of impact) for (const row of r.rows) expect(row.candidates ?? 30).toBeGreaterThanOrEqual(30);

    const cand = await newUser("compliance-cand");
    const view = await retentionOverview(cand.client);
    expect(view).toMatchObject({ queued: 0, next: [], log: [], inProgress: [] });
    await expect(adverseImpactAll(cand.client)).rejects.toThrow(/admin_only/);
    await expect(demographicsCoverage(cand.client)).rejects.toThrow(/admin_only/);
  });

  it("recomputing item statistics is admin-only", async () => {
    h.client = boss.client;
    expect(param(await outcome(recomputeItemStats()), "ok")).toMatch(/Item statistics recomputed/);
    const cand = await newUser("banks-cand");
    h.client = cand.client;
    expect(await outcome(recomputeItemStats())).toBe("404");
  });

  it("item statistics count archived answers and use the rest-score point-biserial", async () => {
    // A live-form template (the paper retest is scored on scorecards, so nothing else answers it
    // in tests): 40 archived answers whose rest scores rise with correctness, so p = .5 and the
    // discrimination is high. No attempt_ref, so KR-20 ignores them; removed afterwards.
    const { data: tmpl } = await admin
      .from("reasoning_items")
      .select("id, exposures, difficulty_p, discrimination")
      .eq("form", "live")
      .eq("family", "verbal")
      .eq("tier", "hard")
      .maybeSingle();
    if (!tmpl) return; // the live pool is seeded by migration 0017
    const before = Number(tmpl.exposures ?? 0);
    const rows = Array.from({ length: 40 }, (_, i) => {
      const correct = i % 2 === 0;
      const rest = (correct ? 8 : 3) + (i % 3);
      return `('reasoning', '${tmpl.id}', 'verbal', 'hard', ${correct}, true, ${rest + (correct ? 1 : 0)}, 'live', '1900-01-01')`;
    });
    psql(`insert into public.item_response_archive (source, item_id, family_or_topic, tier, correct, served, attempt_score, form, cohort_month) values ${rows.join(",")};`);
    try {
      const { data: n, error } = await admin.rpc("refresh_reasoning_item_stats");
      expect(error).toBeNull();
      expect(Number(n)).toBeGreaterThanOrEqual(1);
      const { data: after } = await admin.from("reasoning_items").select("exposures, difficulty_p, discrimination").eq("id", tmpl.id).single();
      expect(after!.exposures).toBe(before + 40);
      if (before === 0) expect(Number(after!.difficulty_p)).toBe(0.5);
      expect(Number(after!.discrimination)).toBeGreaterThan(0.5);
    } finally {
      const lit = (v: unknown) => (v === null || v === undefined ? "null" : String(v));
      psql(`
        delete from public.item_response_archive where item_id = '${tmpl.id}' and cohort_month = '1900-01-01';
        update public.reasoning_items set exposures = ${before}, difficulty_p = ${lit(tmpl.difficulty_p)}, discrimination = ${lit(tmpl.discrimination)} where id = '${tmpl.id}';`);
    }
  });
});
