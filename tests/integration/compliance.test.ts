import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Server actions and pages run as whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { lapseApplications, lookupDispute, purgeNow } from "@/app/admin/compliance/actions";
import { recomputeItemStats } from "@/app/admin/banks/actions";
import { deleteDemographics, saveDemographics } from "@/app/me/demographics/actions";
import { DEMOGRAPHICS_NOTICE_VERSION } from "@/app/me/demographics/notice";
import { adverseImpactAll, adverseImpact, CohortFilter, demographicsCoverage, reliability, retentionOverview } from "@/lib/server/compliance";
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
  // Decisions the admin made go first (decided_by has no ON DELETE), then candidates, then admins.
  psql(`delete from public.decisions where decided_by in (${ids}) or application_id in (select id from public.applications where user_id in (${ids}));
        update public.review_requests set responded_by = null where responded_by in (${ids});
        delete from public.applications where user_id in (${ids});
        delete from auth.users u where u.id in (${ids}) and not exists (select 1 from public.admins a where a.user_id = u.id);
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

  // Test data only: remove the 100 seeded people (cascades their applications, decisions and
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
    //   non-binary 12 and not disclosed 20 (both under 30: never returned; together 32, so the
    //   people outside the shown groups are not a small remainder).
    // Population group: african for the first 40 of those 94 and white for the next 40; the last
    //   14 didn't say: a remainder of 1 to 29, so nothing comes back for that dimension.
    // Plus six female applications that must not count at the quiz: two only held, one
    // undecided, one rejected and then re-opened with a hold, one whose advance released a hold
    // before the quiz was done (so it is still at the quiz), and one closed as lapsed.
    const groups: { gender: string | null; n: number; advanced: number }[] = [
      { gender: "female", n: 32, advanced: 24 },
      { gender: "male", n: 30, advanced: 12 },
      { gender: "non_binary", n: 12, advanced: 12 },
      { gender: null, n: 20, advanced: 5 },
    ];
    const extras = 6;
    const total = groups.reduce((a, g) => a + g.n, 0) + extras;
    const ids = await bulkUsers("ai", total);
    seeded = ids;
    const sql: string[] = [];
    let k = 0;
    const reason = "Test setup: decided on the quiz topic scores and the evidence.";
    const decide = (app: string, stage: string, decision: string, ago: string) =>
      sql.push(`insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at) values ('${app}', '${stage}', '${decision}', '${reason}', '${boss.id}', now() - interval '${ago}');`);
    for (const g of groups) {
      for (let i = 0; i < g.n; i++, k++) {
        const uid = ids[k];
        const app = randomUUID();
        const adv = i < g.advanced;
        const population = k < 40 ? "african" : k < 80 ? "white" : null;
        if (g.gender || population) {
          sql.push(`insert into public.demographics (user_id, gender, population_group) values ('${uid}', ${g.gender ? `'${g.gender}'` : "null"}, ${population ? `'${population}'` : "null"});`);
        }
        sql.push(`insert into public.applications (id, user_id, role_id, stage, status) values ('${app}', '${uid}', '${roleId}', '${adv ? "work_1" : "quiz"}', '${adv ? "advanced" : "rejected"}');`);
        // Rejected first, then advanced on review: the latest decision counts.
        if (g.gender === "female" && i === 0) decide(app, "quiz", "reject", "2 hours");
        decide(app, "quiz", adv ? "advance" : "reject", "1 hour");
        // An earlier stage's decision must not leak into the quiz report.
        decide(app, "interview", "advance", "3 hours");
      }
    }
    const extra: [string, string, [string, string][]][] = [
      ["quiz", "awaiting_review", [["hold", "1 hour"]]],
      ["quiz", "awaiting_review", [["hold", "1 hour"]]],
      ["quiz", "in_progress", []],
      ["quiz", "awaiting_review", [["reject", "2 hours"], ["hold", "1 hour"]]],
      ["quiz", "advanced", [["hold", "2 hours"], ["advance", "1 hour"]]],
      ["quiz", "lapsed", [["lapse", "1 hour"]]],
    ];
    for (const [stage, status, decisions] of extra) {
      const uid = ids[k++];
      const app = randomUUID();
      sql.push(`insert into public.demographics (user_id, gender) values ('${uid}', 'female');`);
      sql.push(`insert into public.applications (id, user_id, role_id, stage, status) values ('${app}', '${uid}', '${roleId}', '${stage}', '${status}');`);
      for (const [decision, ago] of decisions) decide(app, "quiz", decision, ago);
    }
    seed(sql.join("\n"));
  }, 90_000);

  it("reports decided applications per group, leaves out groups under 30 and flags the four-fifths breach", async () => {
    const r = await adverseImpact(boss.client, "quiz", "gender", { role: slug });
    expect(r.rows.map((x) => [x.group, x.candidates, x.advanced])).toEqual([
      ["female", 32, 24],
      ["male", 30, 12],
    ]);
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

  it("never names or counts a group under 30, whatever minimum is asked for", async () => {
    const { data, error } = await boss.client.rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "gender", p_min_n: 2, p_role_slug: slug });
    expect(error).toBeNull();
    const rows = data as Record<string, unknown>[];
    // Only the two groups of 30+ come back: no row (and no hint) for non-binary or not disclosed.
    expect(rows.map((x) => x.grp)).toEqual(["female", "male"]);
    expect(JSON.stringify(rows)).not.toMatch(/non_binary|not_disclosed|hidden|suppressed/);
    expect(Object.keys(rows[0]).sort()).toEqual(["advanced", "candidates", "grp", "rate"]);
  });

  it("returns nothing when a group's complement is under 30 (everyone in one group here)", async () => {
    // Nobody in this cohort disclosed a disability: "not disclosed" holds all 94, so showing it
    // would tell an admin every person's answer.
    const r = await adverseImpact(boss.client, "quiz", "disability", { role: slug });
    expect(r.rows).toEqual([]);
    expect(r.decided).toBe(0);
  });

  it("returns nothing when the people outside the shown groups number 1 to 29", async () => {
    // african 40 and white 40 would each pass on their own (complements of 54), but the 14 who
    // didn't say could then be counted (and their advances worked out) from the pipeline totals.
    expect(psql(`select count(*) from public.demographics d join public.applications a on a.user_id = d.user_id
                 join public.roles r on r.id = a.role_id where r.slug = '${slug}' and d.population_group in ('african', 'white')`).trim()).toBe("80");
    for (const stage of ["quiz", "interview"] as const) {
      const r = await adverseImpact(boss.client, stage, "population_group", { role: slug });
      expect(r.rows).toEqual([]);
    }
  });

  it("holds, lapses, undecided applications and an advance that left them at the stage are not decisions", async () => {
    // The six extra female applications would make female 33 or more (a re-opened rejection
    // counted as rejected, the in-place advance as advanced): the report keeps 32 / 24.
    const r = await adverseImpact(boss.client, "quiz", "gender", { role: slug });
    expect(r.rows.find((x) => x.group === "female")).toMatchObject({ candidates: 32, advanced: 24 });
    expect(psql(`select count(*) from public.decisions d join public.applications a on a.id = d.application_id
                 join public.roles r on r.id = a.role_id where r.slug = '${slug}' and d.decision = 'lapse'`).trim()).toBe("1");
  });

  it("filters by whole cohort months and role, and refuses free date ranges", async () => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    expect((await adverseImpact(boss.client, "quiz", "gender", { role: slug, month: next })).rows).toEqual([]);
    expect((await adverseImpact(boss.client, "quiz", "gender", { role: slug, month })).flagged).toEqual(["male"]);
    // Any day in the month means the whole month.
    const { data: mid } = await boss.client.rpc("adverse_impact_report", { p_stage: "quiz", p_dimension: "gender", p_cohort_month: `${month}-17`, p_role_slug: slug });
    expect((mid as { grp: string }[]).map((x) => x.grp)).toEqual(["female", "male"]);
    // The old day-range parameters are gone.
    const { error: rangeErr } = await boss.client.rpc("adverse_impact_report", {
      p_stage: "quiz", p_dimension: "gender", p_from: `${month}-01T00:00:00Z`, p_to: `${month}-02T00:00:00Z`,
    });
    expect(rangeErr).not.toBeNull();
    // The filter parser keeps months only.
    expect(CohortFilter.parse({ month: "2026-13" })).toEqual({ month: undefined });
    expect(CohortFilter.parse({ month: "2026-09-04" })).toEqual({ month: undefined });
    expect(CohortFilter.parse({ month: "2026-09", role: slug })).toEqual({ month: "2026-09", role: slug });
  });

  it("a cohort of one decided person returns no group names in any dimension", async () => {
    const [uid] = await bulkUsers("ai-one", 1);
    const oneSlug = `ai-one-${randomUUID().slice(0, 8)}`;
    const { data: role, error } = await admin
      .from("roles")
      .insert({ slug: oneSlug, title: "One-person cohort", summary: "Test only.", salary_min: 1, salary_max: 1, active: false })
      .select("id")
      .single();
    if (error) throw error;
    const app = randomUUID();
    seed(`
      insert into public.demographics (user_id, population_group, gender, disability) values ('${uid}', 'indian', 'female', 'yes');
      insert into public.applications (id, user_id, role_id, stage, status, created_at) values ('${app}', '${uid}', '${role.id}', 'interview', 'rejected', '1999-03-04');
      insert into public.decisions (application_id, stage, decision, reason, decided_by) values ('${app}', 'interview', 'reject', 'Test setup: below the interview bar on two criteria.', '${boss.id}');`);
    try {
      for (const dim of ["population_group", "gender", "disability"]) {
        for (const args of [
          { p_cohort_month: "1999-03-01", p_role_slug: oneSlug },
          { p_role_slug: oneSlug },
          { p_cohort_month: "1999-03-04" },
        ]) {
          const { data, error: rpcErr } = await boss.client.rpc("adverse_impact_report", { p_stage: "interview", p_dimension: dim, p_min_n: 1, ...args });
          expect(rpcErr).toBeNull();
          expect(data).toEqual([]);
        }
      }
    } finally {
      psql(`delete from auth.users where id = '${uid}'; delete from public.roles where id = '${role.id}';`);
    }
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

    // Admins get totals only, and never a count from 1 to 29 (the consent promises totals for
    // groups of 30 or more): compared with the true counts, each is shown exactly when safe.
    const cov = await demographicsCoverage(boss.client);
    const raw = psql(`
      with base as (select distinct c.user_id from public.consents c where not exists (select 1 from public.admins ad where ad.user_id = c.user_id)),
           resp as (select d.* from public.demographics d join base b on b.user_id = d.user_id)
      select x.dim || '|' || (select count(*) from resp) || '|' || x.disclosed || '|' || x.prefer_not || '|' || x.blank
      from (
        select 'disability' as dim, count(*) filter (where disability <> 'prefer_not') as disclosed, count(*) filter (where disability = 'prefer_not') as prefer_not, count(*) filter (where disability is null) as blank from resp
        union all
        select 'gender', count(*) filter (where gender <> 'prefer_not'), count(*) filter (where gender = 'prefer_not'), count(*) filter (where gender is null) from resp
        union all
        select 'population_group', count(*) filter (where population_group <> 'prefer_not'), count(*) filter (where population_group = 'prefer_not'), count(*) filter (where population_group is null) from resp
      ) x order by 1`)
      .trim()
      .split("\n")
      .map((line) => line.split("|"));
    const safe = (n: number) => n === 0 || n >= 30;
    const respondents = Number(raw[0][1]);
    expect(cov.candidates).toBeGreaterThanOrEqual(2);
    expect(cov.respondents).toBe(safe(respondents) ? respondents : null);
    expect(cov.dimensions.map((d) => d.dimension)).toEqual(["disability", "gender", "population_group"]);
    expect(Object.keys(cov.dimensions[0]).sort()).toEqual(["dimension", "disclosed", "notAnswered", "preferNot"]);
    for (const [i, d] of cov.dimensions.entries()) {
      const [, , disclosed, preferNot, blank] = raw[i].map(Number);
      const ok = safe(respondents) && safe(disclosed) && safe(preferNot) && safe(blank);
      expect([d.disclosed, d.preferNot, d.notAnswered]).toEqual(ok ? [disclosed, preferNot, blank] : [null, null, null]);
      for (const v of [d.disclosed, d.preferNot, d.notAnswered]) if (v !== null) expect(safe(v)).toBe(true);
    }
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

  it("closing idle applications as lapsed needs an admin, a written reason and the tick box", async () => {
    const [uid] = await bulkUsers("lapse", 1);
    const { data: role, error: roleErr } = await admin
      .from("roles")
      .insert({ slug: `lapse-${randomUUID().slice(0, 8)}`, title: "Lapse test role", summary: "Test only.", salary_min: 1, salary_max: 1, active: false })
      .select("id")
      .single();
    if (roleErr) throw roleErr;
    const app = randomUUID();
    seed(`insert into public.applications (id, user_id, role_id, stage, status) values ('${app}', '${uid}', '${role.id}', 'quiz', 'in_progress');`);
    const reason = "No reply to three reminders since July.";
    const lapseForm = (fields: Record<string, string>, apps: string[]) => {
      const f = form(fields);
      for (const id of apps) f.append("application_id", id);
      return f;
    };
    try {
      const cand = await newUser("lapse-cand");
      h.client = cand.client;
      expect(await outcome(lapseApplications(lapseForm({ reason, ack: "on" }, [app])))).toBe("404");

      h.client = boss.client;
      expect(param(await outcome(lapseApplications(lapseForm({ reason: "too short", ack: "on" }, [app]))), "error")).toMatch(/20 characters/);
      expect(param(await outcome(lapseApplications(lapseForm({ reason, ack: "on" }, []))), "error")).toMatch(/Tick at least one/);
      expect(param(await outcome(lapseApplications(lapseForm({ reason }, [app]))), "error")).toMatch(/Tick the box/);
      expect(psql(`select status from public.applications where id = '${app}'`).trim()).toBe("in_progress");

      const done = await outcome(lapseApplications(lapseForm({ reason, ack: "on" }, [app])));
      expect(param(done, "ok")).toMatch(/Closed 1 application as lapsed/);
      expect(psql(`select status || '|' || (closed_at is not null) from public.applications where id = '${app}'`).trim()).toBe("lapsed|true");
      expect(psql(`select decision || '|' || reason from public.decisions where application_id = '${app}'`).trim()).toBe(`lapse|${reason}`);
      // Already closed: the database refuses and the page says why.
      expect(param(await outcome(lapseApplications(lapseForm({ reason, ack: "on" }, [app]))), "error")).toMatch(/application_not_in_play/);
    } finally {
      psql(`delete from public.decisions where application_id = '${app}'; delete from auth.users where id = '${uid}'; delete from public.roles where id = '${role.id}';`);
    }
  });

  it("the dispute lookup is admin-only and finds nothing for an address never purged", async () => {
    h.client = boss.client;
    const none = await lookupDispute({ status: "idle" }, form({ email: " Never-Purged@example.co.za " }));
    expect(none).toEqual({ status: "found", email: "Never-Purged@example.co.za", result: { purges: [], decisions: [] } });
    expect(await lookupDispute({ status: "idle" }, form({ email: "not an address" }))).toMatchObject({ status: "error" });
    const cand = await newUser("lookup-cand");
    h.client = cand.client;
    expect(await outcome(lookupDispute({ status: "idle" }, form({ email: "x@example.co.za" })))).toBe("404");
  });

  it("the compliance data loads for an admin and is refused to anyone else", async () => {
    const [overview, impact] = await Promise.all([retentionOverview(boss.client), adverseImpactAll(boss.client)]);
    expect(overview.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview.queued).toBeGreaterThanOrEqual(overview.dueNow);
    expect(overview.oldestDue === null || overview.oldestDue <= overview.today).toBe(true);
    expect(Array.isArray(overview.log)).toBe(true);
    for (const entry of overview.log) expect(Object.keys(entry).sort()).toEqual(["detail", "id", "purgedAt", "scope"]);
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
