import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as sweep } from "@/app/api/cron/sweep/route";
import { hashUserId, hmacEmail, listObjects, purgeDue, refreshRetentionQueue, retentionPepper } from "@/lib/server/retention";
import { purgeAfter, utcDay } from "@/lib/stats/retention";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser as newUserRaw, psql, service } from "../helpers/local";

const admin = service();

/** Every account this file creates, removed afterwards so repeated runs don't grow the shared DB. */
const created: string[] = [];
async function newUser(tag: string) {
  const u = await newUserRaw(tag);
  created.push(u.id);
  return u;
}
/** Roles this file creates (inactive test roles), removed afterwards. */
const createdRoles: string[] = [];
afterAll(() => {
  // This run's accounts, plus any an earlier run of this file left behind.
  const leftovers = psql(`select id from auth.users where email ~ '^(ret-[a-z0-9-]+|retention-admin)\\.[0-9]+\\.[0-9]+@example\\.co\\.za$'`)
    .trim()
    .split("\n")
    .filter(Boolean);
  const all = [...new Set([...created, ...leftovers])];
  if (all.length) {
    const ids = all.map((id) => `'${id}'`).join(",");
    // Decisions first (staff accounts here are named on other test candidates' decisions, a
    // reference without ON DELETE), then the applications, then candidates, then admins.
    psql(`delete from public.decisions where decided_by in (${ids}) or application_id in (select id from public.applications where user_id in (${ids}));
          update public.review_requests set responded_by = null where responded_by in (${ids});
          delete from public.applications where user_id in (${ids});
          delete from auth.users u where u.id in (${ids}) and not exists (select 1 from public.admins a where a.user_id = u.id);
          delete from auth.users where id in (${ids});`);
  }
  if (createdRoles.length) psql(`delete from public.roles where id in (${createdRoles.map((id) => `'${id}'`).join(",")});`);
});
const SWE = "software-engineer";

/** Test setup only: writes rows directly with triggers off for this session. */
function seed(sql: string) {
  psql(`set session_replication_role = replica; ${sql}`);
}
const one = (sql: string) => psql(sql).trim();

type U = Awaited<ReturnType<typeof newUser>>;

async function applicant(tag: string): Promise<U & { appId: string; attemptId: string }> {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  const attemptId = await fakeFinishedAttempt(u.id, 4);
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: SWE });
  if (error) throw error;
  return { ...u, appId: data as string, attemptId };
}

/** Moves a person's whole history `months` into the past (sign-up, consent, CV, attempts, applications). */
function backdate(userId: string, months: number) {
  const at = `now() - interval '${months} months'`;
  seed(`
    update auth.users set created_at = ${at} where id = '${userId}';
    update public.consents set accepted_at = ${at} where user_id = '${userId}';
    update public.cvs set created_at = ${at} where user_id = '${userId}';
    update public.reasoning_attempts set started_at = ${at}, deadline_at = ${at} + interval '15 minutes', submitted_at = ${at} + interval '10 minutes' where user_id = '${userId}';
    update public.applications set created_at = ${at} where user_id = '${userId}';
    update public.review_requests set created_at = ${at}, responded_at = case when responded_at is null then null else ${at} end where user_id = '${userId}';
  `);
}

/** Closes the application `months` ago with an admin rejection (decision row included). */
function rejectAt(appId: string, adminId: string, months: number) {
  seed(`
    insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at)
      values ('${appId}', 'quiz', 'reject', 'Test setup: below the quiz bar on two of the topics.', '${adminId}', now() - interval '${months} months');
    update public.applications set status = 'rejected', stage = 'quiz', closed_at = now() - interval '${months} months' where id = '${appId}';
  `);
}

function closedAtOf(appId: string): string {
  return one(`select to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from public.applications where id = '${appId}'`);
}

async function queueRow(userId: string) {
  const { data } = await admin.from("retention_queue").select("purge_after, reason, basis_at").eq("user_id", userId).maybeSingle();
  return data as { purge_after: string; reason: string; basis_at: string } | null;
}

async function upload(bucket: string, path: string, body = "x", contentType = "text/plain") {
  const { error } = await admin.storage.from(bucket).upload(path, Buffer.from(body), { contentType, upsert: true });
  if (error) throw new Error(`${bucket}/${path}: ${error.message}`);
}

function storageCount(prefixes: string[]): number {
  const list = prefixes.map((p) => `'${p}'`).join(",");
  return Number(one(`select count(*) from storage.objects where split_part(name, '/', 1) in (${list})`));
}

/** Every public uuid column that holds this id (should be none after a purge). */
function rowsKeyedBy(id: string): string[] {
  const cols = psql(`
    select c.table_name || '.' || c.column_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.data_type = 'uuid' and t.table_type = 'BASE TABLE'`)
    .trim()
    .split("\n")
    .filter(Boolean);
  return cols.filter((tc) => {
    const [table, column] = tc.split(".");
    return one(`select exists (select 1 from public.${table} where ${column} = '${id}')`) === "t";
  });
}

let boss: U;
let items: { id: string; family: string; tier: string }[];
let quizItem: { id: string; topic: string };
let rubricId: string;
let stageId: string;
let stageKey: string;

beforeAll(async () => {
  boss = await newUser("retention-admin");
  await makeAdmin(boss.id);
  const { data: it } = await admin.from("reasoning_items").select("id, family, tier").eq("form", "online").limit(3);
  items = it as typeof items;
  const { data: q } = await admin.from("quiz_items").select("id, topic").eq("role_slug", SWE).limit(1).single();
  quizItem = q as typeof quizItem;
  const { data: r } = await admin.from("rubrics").select("id").eq("active", true).limit(1).single();
  rubricId = r!.id as string;
  const { data: st } = await admin.from("work_stages").select("id, key").eq("role_slug", SWE).eq("app_stage", "work_1").single();
  stageId = st!.id as string;
  stageKey = st!.key as string;
});

/**
 * A rejected candidate with a full history: decisions, reasoning and quiz responses, an
 * interview with grades, a submission with grades and a snapshot, signals, a review request,
 * demographics, dedupe flags both ways, and files in every bucket keyed by them.
 */
async function fullCandidate(tag: string, opts: { files?: number } = {}) {
  const u = await applicant(tag);
  const other = await newUser(`${tag}-other`);
  const otherCv = await fakeParsedCv(other.id);
  const myCv = one(`select id from public.cvs where user_id = '${u.id}' limit 1`);
  const session = randomUUID();
  const workAttempt = randomUUID();
  const sub = randomUUID();
  const quizAttempt = randomUUID();
  seed(`
    insert into public.reasoning_responses (attempt_id, position, item_id, family, tier, seed, rendered, answer_key, served_at, answered_at, answer, correct) values
      ('${u.attemptId}', 1, '${items[0].id}', '${items[0].family}', '${items[0].tier}', 1, '{}', 0, now() - interval '5 minutes', now() - interval '4 minutes 30 seconds', 0, true),
      ('${u.attemptId}', 2, '${items[1].id}', '${items[1].family}', '${items[1].tier}', 2, '{}', 1, now() - interval '4 minutes', now() - interval '3 minutes', 2, false),
      ('${u.attemptId}', 3, '${items[2].id}', '${items[2].family}', '${items[2].tier}', 3, '{}', 2, null, null, null, null);
    insert into public.quiz_attempts (id, application_id, user_id, seed, started_at, deadline_at, submitted_at, raw_score, pct)
      values ('${quizAttempt}', '${u.appId}', '${u.id}', 7, now() - interval '20 minutes', now() - interval '8 minutes', now() - interval '9 minutes', 1, 50);
    insert into public.quiz_responses (attempt_id, position, item_id, topic, rendered, answer_key, served_at, answered_at, answer, correct) values
      ('${quizAttempt}', 1, '${quizItem.id}', '${quizItem.topic}', '{}', '{0}', now() - interval '19 minutes', now() - interval '18 minutes', '{0}', true),
      ('${quizAttempt}', 2, '${quizItem.id}', '${quizItem.topic}', '{}', '{1}', now() - interval '17 minutes', now() - interval '16 minutes', '{0}', false);
    insert into public.interview_sessions (id, application_id, user_id, plan, started_at, deadline_at, ended_at, end_reason, score, summary)
      values ('${session}', '${u.appId}', '${u.id}', '{}', now() - interval '40 minutes', now() - interval '5 minutes', now() - interval '6 minutes', 'completed', 60, '{}');
    insert into public.work_attempts (id, application_id, stage_id, user_id, open_until, started_at, submitted_at)
      values ('${workAttempt}', '${u.appId}', '${stageId}', '${u.id}', now(), now() - interval '2 days', now() - interval '1 day');
    insert into public.submissions (id, attempt_id, user_id, stage_key, score, grading_status)
      values ('${sub}', '${workAttempt}', '${u.id}', '${stageKey}', 70, 'done');
    insert into public.grades (subject_type, subject_id, rubric_id, criterion_key, sample_idx, score, evidence, rationale, model, prompt_version, temperature) values
      ('submission', '${sub}', '${rubricId}', 'c1', 0, 4, '[{"quote":"my words"}]', 'r', 'stub', 'p.v1', 0.3),
      ('interview', '${session}', '${rubricId}', 'c1', 0, 3, '[{"quote":"spoken"}]', 'r', 'stub', 'p.v1', 0.3);
    insert into public.grade_summaries (subject_type, subject_id, rubric_id, criterion_key, weight, median_score, final_score)
      values ('submission', '${sub}', '${rubricId}', 'c1', 1, 4, 4), ('interview', '${session}', '${rubricId}', 'c1', 1, 3, 3);
    insert into public.grading_jobs (subject_type, subject_id, status) values ('submission', '${sub}', 'done'), ('interview', '${session}', 'done');
    insert into public.signals (user_id, context, kind, payload) values ('${u.id}', 'quiz', 'blur', '{}');
    insert into public.review_requests (user_id, application_id, stage, message, status, response, responded_by, responded_at)
      values ('${u.id}', '${u.appId}', 'quiz', 'Please re-check question 4 for me.', 'closed', 'Checked: the key was right.', '${boss.id}', now());
    insert into public.dedupe_flags (cv_id, user_id, matched_cv_id, matched_user_id, kind) values
      ('${myCv}', '${u.id}', '${otherCv}', '${other.id}', 'identity'),
      ('${otherCv}', '${other.id}', '${myCv}', '${u.id}', 'identity');
  `);
  const { error: demoErr } = await u.client.from("demographics").insert({ gender: "female", disability: "no" });
  if (demoErr) throw demoErr;

  await upload("cvs", `${u.id}/cv.pdf`, "%PDF-1.4", "application/pdf");
  await upload("submissions", `${u.id}/${workAttempt}/memo.md`, "# memo", "text/markdown");
  await upload("interview-audio", `${u.id}/${session}/turn-1.webm`, "audio", "audio/webm");
  await upload("snapshots", `${sub}/1-mvp_url.html`, "<html></html>", "text/plain");
  const extra = opts.files ?? 0;
  for (let i = 0; i < extra; i += 20) {
    await Promise.all(
      Array.from({ length: Math.min(20, extra - i) }, (_, j) => upload("submissions", `${u.id}/bulk/f-${String(i + j).padStart(3, "0")}.txt`)),
    );
  }

  rejectAt(u.appId, boss.id, 7);
  backdate(u.id, 8);
  return { ...u, other, session, sub, workAttempt, quizAttempt };
}

describe("retention queue rules (docs/12, notice: 6 months, 12 for the talent pool)", () => {
  it("queues closed applications 6 months after closing, talent pool 12, and never open, appointed, admin or disputing people", async () => {
    const rejected = await applicant("ret-rejected");
    rejectAt(rejected.appId, boss.id, 2);
    backdate(rejected.id, 3);

    const pool = await applicant("ret-pool");
    const { error: poolErr } = await pool.client.from("consents").insert({
      notice_version: "test", accepted_processing: true, accepted_ai_assessment: true, accepted_offshore_processing: true, talent_pool_opt_in: true,
    });
    if (poolErr) throw poolErr;
    rejectAt(pool.appId, boss.id, 2);
    backdate(pool.id, 3);
    // backdate() gives both consents the same time; the opt-in came after the first one.
    seed(`update public.consents set accepted_at = accepted_at + interval '1 minute' where user_id = '${pool.id}' and talent_pool_opt_in;`);

    // Opted in, then out: the latest consent decides.
    const optedOut = await applicant("ret-optout");
    seed(`update public.consents set talent_pool_opt_in = true, accepted_at = now() - interval '4 months' where user_id = '${optedOut.id}';`);
    await consent(optedOut.client);
    seed(`update public.consents set accepted_at = now() - interval '3 months' where user_id = '${optedOut.id}' and not talent_pool_opt_in;`);
    rejectAt(optedOut.appId, boss.id, 2);
    seed(`update auth.users set created_at = now() - interval '5 months' where id = '${optedOut.id}';
          update public.cvs set created_at = now() - interval '5 months' where user_id = '${optedOut.id}';
          update public.reasoning_attempts set started_at = now() - interval '5 months', deadline_at = now() - interval '5 months' + interval '15 minutes', submitted_at = now() - interval '5 months' + interval '10 minutes' where user_id = '${optedOut.id}';
          update public.applications set created_at = now() - interval '5 months' where user_id = '${optedOut.id}';`);

    const open = await applicant("ret-open");
    backdate(open.id, 10); // signed up and applied long ago, but still in play: a quiz last month
    seed(`insert into public.quiz_attempts (application_id, user_id, seed, started_at, deadline_at, submitted_at, raw_score, pct)
          values ('${open.appId}', '${open.id}', 1, now() - interval '1 month', now() - interval '1 month' + interval '20 minutes', now() - interval '1 month' + interval '15 minutes', 5, 50);`);

    const disputing = await applicant("ret-dispute");
    rejectAt(disputing.appId, boss.id, 8);
    backdate(disputing.id, 9);
    const { error: rrErr } = await disputing.client.from("review_requests").insert({ application_id: disputing.appId, stage: "decision", message: "Please review my rejection." });
    if (rrErr) throw rrErr;

    const hired = await applicant("ret-hired");
    seed(`update public.applications set stage = 'closed', status = 'advanced', closed_at = now() - interval '9 months' where id = '${hired.appId}';`);
    backdate(hired.id, 10);

    const staff = await newUser("ret-staff");
    await makeAdmin(staff.id);
    backdate(staff.id, 12);

    // A former admin: removed from admins, but named on a decision (a staff record).
    const former = await newUser("ret-former-staff");
    await consent(former.client);
    seed(`insert into public.decisions (application_id, stage, decision, reason, decided_by)
            values ('${disputing.appId}', 'quiz', 'hold', 'Test setup: held while the dispute is looked at.', '${former.id}');`);
    backdate(former.id, 12);

    const never = await newUser("ret-never");
    await consent(never.client);
    backdate(never.id, 2);

    expect(await refreshRetentionQueue(admin)).toBeGreaterThan(0);

    const r1 = await queueRow(rejected.id);
    expect(r1).toMatchObject({ reason: "Not appointed: 6 months after the application closed" });
    expect(r1!.purge_after).toBe(purgeAfter(closedAtOf(rejected.appId), false));
    expect(new Date(r1!.basis_at).toISOString()).toBe(closedAtOf(rejected.appId));

    const r2 = await queueRow(pool.id);
    expect(r2).toMatchObject({ reason: "Talent pool: 12 months after the application closed" });
    expect(r2!.purge_after).toBe(purgeAfter(closedAtOf(pool.appId), true));

    const r3 = await queueRow(optedOut.id);
    expect(r3!.reason).toMatch(/^Not appointed: 6 months/);
    expect(r3!.purge_after).toBe(purgeAfter(closedAtOf(optedOut.appId), false));

    const r4 = await queueRow(never.id);
    expect(r4!.reason).toBe("Not appointed: 6 months after the last activity (never applied)");
    expect(r4!.purge_after).toBe(purgeAfter(r4!.basis_at, false));

    expect(await queueRow(open.id)).toBeNull();
    expect(await queueRow(disputing.id)).toBeNull();
    expect(await queueRow(hired.id)).toBeNull();
    expect(await queueRow(staff.id)).toBeNull();
    expect(await queueRow(former.id)).toBeNull();
    const { data: formerSched } = await admin.rpc("retention_schedule", { p_user_ids: [former.id] });
    expect(formerSched).toEqual([]);

    // Re-opening an application (an admin releases the rejection) takes the person off the queue.
    seed(`update public.applications set status = 'awaiting_review', closed_at = null where id = '${rejected.appId}';`);
    await refreshRetentionQueue(admin);
    expect(await queueRow(rejected.id)).toBeNull();

    // None of these is due yet (closed 2 months ago), so a purge leaves them alone.
    const report = await purgeDue(admin, { userIds: [pool.id, optedOut.id, never.id] });
    expect(report.outcomes).toEqual([]);
  });

  it("stamps closed_at when an application closes and clears it when it re-opens", async () => {
    const u = await applicant("ret-closedat");
    const closedAt = () => one(`select coalesce(closed_at::text, 'null') from public.applications where id = '${u.appId}'`);
    expect(closedAt()).toBe("null");
    const { error: rejErr } = await boss.client.rpc("admin_decide", {
      p_application_id: u.appId, p_decision: "reject", p_reason: "Test: below the interview bar on two criteria.",
    });
    expect(rejErr).toBeNull();
    const first = closedAt();
    expect(first).not.toBe("null");
    // Later writes that don't change the status (e.g. a composite refresh) keep the close time.
    psql(`update public.applications set composite_score = 12 where id = '${u.appId}'`);
    expect(closedAt()).toBe(first);
    // An admin hold re-opens it.
    const { error: holdErr } = await boss.client.rpc("admin_decide", {
      p_application_id: u.appId, p_decision: "hold", p_reason: "Test: re-opened after the candidate's review request.",
    });
    expect(holdErr).toBeNull();
    expect(closedAt()).toBe("null");
  });
});

describe("applications in play are never queued (hard rule 3: only an admin closes one, with a reason)", () => {
  it("keeps idle and closed-round applications off the queue; an admin lapse with a written reason starts the clock", async () => {
    // A role whose hiring round closed 7 months ago (made inactive), with someone mid-pipeline:
    // offer accepted but never advanced to appointed.
    const slug = `ret-role-${randomUUID().slice(0, 8)}`;
    const { data: role, error: roleErr } = await admin
      .from("roles")
      .insert({ slug, title: "Retention test role", summary: "Test only.", salary_min: 1, salary_max: 1, active: false })
      .select("id")
      .single();
    if (roleErr) throw roleErr;
    createdRoles.push(role.id as string);
    seed(`update public.roles set round_closed_at = now() - interval '7 months' where id = '${role.id}';`);

    const offer = await newUser("ret-offer");
    await consent(offer.client);
    await fakeParsedCv(offer.id);
    await fakeFinishedAttempt(offer.id, 4);
    const offerApp = randomUUID();
    seed(`
      insert into public.applications (id, user_id, role_id, stage, status) values ('${offerApp}', '${offer.id}', '${role.id}', 'offer', 'advanced');
      insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at)
        values ('${offerApp}', 'live', 'advance', 'Test setup: strong live panel on all four criteria.', '${boss.id}', now() - interval '8 months');`);
    backdate(offer.id, 9);

    // Shortlisted on an open role, then nothing for 13 months.
    const idle = await applicant("ret-idle");
    seed(`
      update public.applications set stage = 'shortlist', status = 'advanced' where id = '${idle.appId}';
      insert into public.decisions (application_id, stage, decision, reason, decided_by, decided_at)
        values ('${idle.appId}', 'work_2', 'advance', 'Test setup: SWE Test 2 memo met the bar on costing.', '${boss.id}', now() - interval '13 months');`);
    backdate(idle.id, 14);

    await refreshRetentionQueue(admin);
    expect(await queueRow(offer.id)).toBeNull();
    expect(await queueRow(idle.id)).toBeNull();
    const { data: sched } = await admin.rpc("retention_schedule", { p_user_ids: [offer.id, idle.id] });
    expect(sched).toEqual([]);
    // Even far in the future, a purge refuses them, and a run leaves both applications alone.
    const { data: refused } = await admin.rpc("retention_begin_purge", { p_user_id: offer.id, p_hash: hashUserId(offer.id), p_today: "2100-01-01" });
    expect(refused).toMatchObject({ status: "not_eligible" });
    const run = await purgeDue(admin, { userIds: [offer.id, idle.id], now: new Date("2100-01-01T00:00:00Z") });
    expect(run.outcomes).toEqual([]);
    expect(one(`select count(*) from public.applications where id in ('${offerApp}', '${idle.appId}')`)).toBe("2");
    expect(one(`select count(*) from public.retention_purges where user_id in ('${offer.id}', '${idle.id}')`)).toBe("0");

    // Both are on the admin's to-do list.
    const { data: stale, error: staleErr } = await boss.client.rpc("retention_stale_applications", { p_months: 3 });
    expect(staleErr).toBeNull();
    const staleIds = (stale as { application_id: string }[]).map((r) => r.application_id);
    expect(staleIds).toEqual(expect.arrayContaining([offerApp, idle.appId]));
    expect(Object.keys((stale as object[])[0]).sort()).toEqual(
      ["application_id", "last_activity", "role_slug", "round_closed_at", "stage", "status", "user_id"].sort(),
    );

    // Closing as lapsed: admin only, with a written reason, only while in play.
    const reason = "No response to our two follow-ups since the shortlist email.";
    const { error: candErr } = await idle.client.rpc("admin_lapse_applications", { p_application_ids: [idle.appId], p_reason: reason });
    expect(candErr?.message).toMatch(/admin_only/);
    const { error: shortErr } = await boss.client.rpc("admin_lapse_applications", { p_application_ids: [idle.appId], p_reason: "idle" });
    expect(shortErr?.message).toMatch(/reason_too_short/);
    const { data: n, error: lapseErr } = await boss.client.rpc("admin_lapse_applications", { p_application_ids: [idle.appId], p_reason: reason });
    expect(lapseErr).toBeNull();
    expect(n).toBe(1);
    expect(one(`select status || '|' || stage || '|' || (closed_at is not null) from public.applications where id = '${idle.appId}'`)).toBe("lapsed|shortlist|true");
    expect(one(`select decision || '|' || stage || '|' || reason || '|' || (decided_by = '${boss.id}') from public.decisions where application_id = '${idle.appId}' order by decided_at desc limit 1`)).toBe(
      `lapse|shortlist|${reason}|true`,
    );
    const { error: againErr } = await boss.client.rpc("admin_lapse_applications", { p_application_ids: [idle.appId], p_reason: reason });
    expect(againErr?.message).toMatch(/application_not_in_play/);

    // The clock starts from the lapse; the offer is still in play and still off the queue.
    await refreshRetentionQueue(admin);
    const lapsed = await queueRow(idle.id);
    expect(lapsed).toMatchObject({ reason: "Not appointed: 6 months after the application closed" });
    expect(lapsed!.purge_after).toBe(purgeAfter(closedAtOf(idle.appId), false));
    expect(lapsed!.purge_after > utcDay()).toBe(true);
    expect(await queueRow(offer.id)).toBeNull();
    const { data: staleAfter } = await boss.client.rpc("retention_stale_applications", { p_months: 3 });
    expect((staleAfter as { application_id: string }[]).map((r) => r.application_id)).not.toContain(idle.appId);
  });
});

describe("purge (docs/12 §1 retention automation)", () => {
  it("a dry run reports who and what would go, and changes nothing", async () => {
    const u = await fullCandidate("ret-dry");
    const hash = hashUserId(u.id);
    const before = {
      objects: storageCount([u.id, u.sub]),
      archive: one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`),
      log: one(`select count(*) from public.purge_log`),
      items: one(`select count(*) from public.item_response_archive`),
      grades: one(`select count(*) from public.grades where subject_id in ('${u.sub}', '${u.session}')`),
    };
    expect(before.objects).toBe(4);

    const report = await purgeDue(admin, { dryRun: true, userIds: [u.id] });
    expect(report).toMatchObject({ dryRun: true, due: 1, purged: 0, outcomes: [] });
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]).toMatchObject({
      userId: u.id,
      decisions: 1,
      reasoningResponses: 3,
      quizResponses: 2,
      grades: 2,
      storage: { cvs: 1, submissions: 1, "interview-audio": 1, snapshots: 1 },
    });

    const { data: still } = await admin.auth.admin.getUserById(u.id);
    expect(still.user?.id).toBe(u.id);
    expect(storageCount([u.id, u.sub])).toBe(before.objects);
    expect(one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`)).toBe(before.archive);
    expect(one(`select count(*) from public.purge_log`)).toBe(before.log);
    expect(one(`select count(*) from public.item_response_archive`)).toBe(before.items);
    expect(one(`select count(*) from public.grades where subject_id in ('${u.sub}', '${u.session}')`)).toBe(before.grades);
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("0");
    expect(one(`select count(*) from public.decisions d join public.applications a on a.id = d.application_id where a.user_id = '${u.id}'`)).toBe("1");
  });

  it("archives decisions under a hashed id and item responses with no link, deletes every file and the user, logs it, and is idempotent", async () => {
    const u = await fullCandidate("ret-full", { files: 101 }); // > one page of 100 in the listing
    const hash = hashUserId(u.id);
    expect(hash).toBe(createHash("sha256").update(u.id + retentionPepper()).digest("hex"));
    expect(storageCount([u.id, u.sub])).toBe(105);
    // Start from an empty holding table so this person's held answers can be read back.
    await admin.rpc("retention_release_archive", { p_min_people: 1 });
    expect(one(`select count(*) from public.retention_archive_pending`)).toBe("0");
    const items0 = Number(one(`select count(*) from public.item_response_archive`));

    const report = await purgeDue(admin, { userIds: [u.id], triggeredBy: "test" });
    expect(report.failed).toBe(0);
    expect(report.outcomes).toHaveLength(1);
    const out = report.outcomes[0];
    expect(out).toMatchObject({ userIdHash: hash, status: "purged", resumed: false });

    // Decision log: hashed id, criterion-referenced reason, no raw id anywhere.
    const { data: dec } = await admin.from("decision_archive").select("*").eq("user_id_hash", hash);
    expect(dec).toHaveLength(1);
    expect(dec![0]).toMatchObject({ role_slug: SWE, stage: "quiz", decision: "reject", reason: "Test setup: below the quiz bar on two of the topics." });
    expect(JSON.stringify(dec)).not.toContain(u.id);
    // Also keyed by an HMAC of the e-mail address, which a disputant can give later: an admin
    // finds the log through the lookup (case and spaces don't matter), never by a hash.
    expect(dec![0].subject_hmac).toBe(hmacEmail(u.email));
    const { data: found, error: lookErr } = await boss.client.rpc("retention_archive_lookup", { p_subject_hmac: hmacEmail(` ${u.email.toUpperCase()} `) });
    expect(lookErr).toBeNull();
    expect(found).toMatchObject({
      purges: [{ scope: "candidate" }],
      decisions: [{ role_slug: SWE, stage: "quiz", decision: "reject", reason: "Test setup: below the quiz bar on two of the topics." }],
    });
    expect(JSON.stringify(found)).not.toMatch(new RegExp(`${u.id}|${hash}`));

    // Item responses: 3 reasoning (unanswered counts as wrong) + 2 quiz, with a fresh attempt ref,
    // held until at least 5 finished purges can be released together.
    expect(Number(one(`select count(*) from public.item_response_archive`))).toBe(items0);
    const { data: held } = await admin.from("retention_archive_pending").select("*");
    expect(held).toHaveLength(5);
    expect(new Set(held!.map((r) => r.purge_ref)).size).toBe(1);
    expect(one(`select count(*) from public.retention_purges where archive_ref = '${held![0].purge_ref}'`)).toBe("0");
    expect(JSON.stringify(held)).not.toContain(u.id);
    // The statistics count finished purges' held answers already.
    const { data: kr } = await admin.rpc("retention_release_archive", { p_min_people: 5 });
    expect(kr).toBe(0); // only one person waiting: nothing released
    const { data: moved } = await admin.rpc("retention_release_archive", { p_min_people: 1 });
    expect(moved).toBe(5);
    const items1 = Number(one(`select count(*) from public.item_response_archive`));
    expect(items1 - items0).toBe(5);
    const { data: arch } = await admin.from("item_response_archive").select("*").order("id", { ascending: false }).limit(5);
    const reasoning = arch!.filter((r) => r.source === "reasoning").sort((a, b) => a.position - b.position);
    expect(reasoning.map((r) => [r.position, r.correct, r.served, r.form])).toEqual([
      [1, true, true, "online"],
      [2, false, true, "online"],
      [3, false, false, "online"],
    ]);
    expect(Number(reasoning[0].seconds)).toBe(30);
    expect(new Set(reasoning.map((r) => r.attempt_ref)).size).toBe(1);
    expect(reasoning[0].attempt_ref).not.toBe(u.attemptId);
    const quiz = arch!.filter((r) => r.source === "quiz");
    expect(quiz.map((r) => [r.family_or_topic, r.correct])).toEqual(expect.arrayContaining([[quizItem.topic, true], [quizItem.topic, false]]));
    expect(quiz[0].attempt_ref).not.toBe(u.quizAttempt);
    expect(Object.keys(arch![0]).sort()).toEqual(
      ["archived_at", "attempt_ref", "attempt_score", "cohort_month", "correct", "family_or_topic", "form", "id", "item_id", "position", "seconds", "served", "source", "tier"].sort(),
    );
    // Kept to the month, so a row's time can't be matched to one purge.
    const monthStart = one(`select to_char(date_trunc('month', now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')`);
    for (const r of arch!) expect(new Date(r.archived_at).toISOString().slice(0, 19)).toBe(monthStart);
    expect(JSON.stringify(arch)).not.toContain(u.id);

    // Storage: nothing left in any bucket (cvs, submissions, interview-audio, snapshots).
    expect(storageCount([u.id, u.sub, u.session])).toBe(0);
    for (const bucket of ["cvs", "submissions", "interview-audio"]) expect(await listObjects(admin, bucket, u.id)).toEqual([]);
    expect(await listObjects(admin, "snapshots", u.sub)).toEqual([]);

    // The auth user and everything keyed by them, including grades (no foreign key) and both
    // sides of the dedupe flags.
    const { data: gone } = await admin.auth.admin.getUserById(u.id);
    expect(gone.user ?? null).toBeNull();
    expect(rowsKeyedBy(u.id)).toEqual([]);
    expect(one(`select count(*) from public.grades where subject_id in ('${u.sub}', '${u.session}')`)).toBe("0");
    expect(one(`select count(*) from public.grade_summaries where subject_id in ('${u.sub}', '${u.session}')`)).toBe("0");
    expect(one(`select count(*) from public.grading_jobs where subject_id in ('${u.sub}', '${u.session}')`)).toBe("0");
    expect(one(`select count(*) from public.dedupe_flags where user_id = '${u.other.id}' or matched_user_id = '${u.other.id}'`)).toBe("0");
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("0");
    expect(one(`select count(*) from auth.audit_log_entries where payload->>'actor_id' = '${u.id}'`)).toBe("0");
    // The other account is untouched.
    expect((await admin.auth.admin.getUserById(u.other.id)).data.user?.id).toBe(u.other.id);

    // purge_log: hashed id, scope and counts.
    const { data: log } = await admin.from("purge_log").select("*").eq("user_id_hash", hash);
    expect(log).toHaveLength(1);
    expect(log![0].scope).toBe("candidate");
    expect(log![0].detail).toMatchObject({
      decisions_archived: 1,
      reasoning_responses_archived: 3,
      quiz_responses_archived: 2,
      grades_deleted: 2,
      grade_summaries_deleted: 2,
      grading_jobs_deleted: 2,
      storage_objects_deleted: { cvs: 1, submissions: 102, "interview-audio": 1, snapshots: 1 },
      triggered_by: "test",
    });
    expect(JSON.stringify(log)).not.toContain(u.id);

    // Idempotent: a second run finds nothing to do and writes nothing.
    const again = await purgeDue(admin, { userIds: [u.id] });
    expect(again.outcomes).toEqual([]);
    expect(one(`select count(*) from public.purge_log where user_id_hash = '${hash}'`)).toBe("1");
    expect(one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`)).toBe("1");
    expect(Number(one(`select count(*) from public.item_response_archive`))).toBe(items1);
  });

  it("finishes a purge that stopped after archiving, without archiving twice", async () => {
    const u = await fullCandidate("ret-resume1");
    const hash = hashUserId(u.id);
    const { data: started, error } = await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hash, p_today: utcDay() });
    expect(error).toBeNull();
    expect(started).toMatchObject({ status: "started" });
    // A second begin (a concurrent or repeated run) resumes instead of archiving again.
    const { data: again } = await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hash, p_today: utcDay() });
    expect(again).toMatchObject({ status: "resumed" });
    expect(one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`)).toBe("1");

    const report = await purgeDue(admin, { userIds: [u.id] });
    expect(report.outcomes[0]).toMatchObject({ status: "purged", resumed: true });
    expect(one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`)).toBe("1");
    expect(storageCount([u.id, u.sub])).toBe(0);
    expect(rowsKeyedBy(u.id)).toEqual([]);
    expect(one(`select count(*) from public.purge_log where user_id_hash = '${hash}'`)).toBe("1");
  });

  it("finishes a purge that stopped after the auth user was deleted (files and log still to do)", async () => {
    const u = await fullCandidate("ret-resume2");
    const hash = hashUserId(u.id);
    await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hash, p_today: utcDay() });
    const { error } = await admin.auth.admin.deleteUser(u.id);
    expect(error).toBeNull();
    // The state row has no foreign key, so it survived; the files are still there.
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("1");
    expect(storageCount([u.id, u.sub])).toBe(4);

    const report = await purgeDue(admin, { userIds: [u.id] });
    expect(report.outcomes[0]).toMatchObject({ status: "purged", resumed: true });
    expect(storageCount([u.id, u.sub])).toBe(0);
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("0");
    const { data: log } = await admin.from("purge_log").select("detail").eq("user_id_hash", hash).single();
    expect(log!.detail).toMatchObject({ decisions_archived: 1, storage_objects_deleted: { cvs: 1, submissions: 1, "interview-audio": 1, snapshots: 1 } });
  });

  it("keeps a purge in progress (and says why) if something keyed by the person survives", async () => {
    const u = await fullCandidate("ret-stuck");
    await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hashUserId(u.id), p_today: utcDay() });
    await admin.auth.admin.deleteUser(u.id);
    // A stray row with no foreign key that still names the person.
    const strayJob = randomUUID();
    seed(`insert into public.grading_jobs (id, subject_type, subject_id, status) values ('${strayJob}', 'gold', '${u.id}', 'done');`);
    try {
      const report = await purgeDue(admin, { userIds: [u.id] });
      expect(report.outcomes[0]).toMatchObject({ status: "failed" });
      expect((report.outcomes[0] as { error: string }).error).toMatch(/purge_left_rows: grading_jobs\.subject_id/);
      const { data: st } = await admin.from("retention_purges").select("attempts, last_error").eq("user_id", u.id).single();
      expect(st).toMatchObject({ attempts: 1 });
      expect(st!.last_error).toMatch(/grading_jobs/);
    } finally {
      seed(`delete from public.grading_jobs where id = '${strayJob}';`);
    }
    const retry = await purgeDue(admin, { userIds: [u.id] });
    expect(retry.outcomes[0]).toMatchObject({ status: "purged", resumed: true });
  });

  it("undoes a purge whose person is no longer due, lifting the suspension before the state row goes", async () => {
    const u = await fullCandidate("ret-cancel");
    const hash = hashUserId(u.id);
    const { data: started } = await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hash, p_today: utcDay(), p_subject_hmac: hmacEmail(u.email) });
    expect(started).toMatchObject({ status: "started" });
    // As a run does before deleting the account: note the suspension, then suspend.
    await admin.rpc("retention_note_progress", { p_user_id: u.id, p_step: "ban" });
    const { error: banErr } = await admin.auth.admin.updateUserById(u.id, { ban_duration: "876000h" });
    expect(banErr).toBeNull();
    expect(one(`select banned_at is not null from public.retention_purges where user_id = '${u.id}'`)).toBe("t");

    // They become active again (a new consent today), so they are no longer due.
    seed(`insert into public.consents (user_id, notice_version, accepted_processing, accepted_ai_assessment, accepted_offshore_processing)
          values ('${u.id}', 'test', true, true, true);`);
    // The database reports "cancel" but keeps the row (and the block on re-opening) until the
    // server has lifted the suspension.
    const { data: again } = await admin.rpc("retention_begin_purge", { p_user_id: u.id, p_hash: hash, p_today: utcDay() });
    expect(again).toMatchObject({ status: "cancel", reason: "not_due" });
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("1");

    const report = await purgeDue(admin, { userIds: [u.id] });
    expect(report.outcomes).toEqual([{ userIdHash: hash, status: "skipped", reason: "cancelled (not_due)" }]);
    expect(one(`select count(*) from public.retention_purges where user_id = '${u.id}'`)).toBe("0");
    expect(one(`select count(*) from public.decision_archive where user_id_hash = '${hash}'`)).toBe("0");
    expect(one(`select scope from public.purge_log where user_id_hash = '${hash}'`)).toBe("cancelled");
    // The account is back: not banned, and they can sign in.
    expect(one(`select coalesce(banned_until::text, 'none') from auth.users where id = '${u.id}'`)).toBe("none");
    const { error: signInErr } = await anon().auth.signInWithPassword({ email: u.email, password: "test-password-123" });
    expect(signInErr).toBeNull();
    expect(storageCount([u.id, u.sub])).toBe(4);
  });

  it("refuses uploads under a purged id, and deletes files that arrived after the purge anyway", async () => {
    const u = await applicant("ret-late");
    // A consenting candidate can upload their work (positive control for the policy).
    const own = await u.client.storage.from("submissions").upload(`${u.id}/before/memo.md`, Buffer.from("# memo"), { contentType: "text/markdown" });
    expect(own.error).toBeNull();
    rejectAt(u.appId, boss.id, 7);
    backdate(u.id, 8);
    const report = await purgeDue(admin, { userIds: [u.id] });
    expect(report.outcomes[0]).toMatchObject({ status: "purged" });

    // Their access token is still valid for a while, but the account and consent are gone.
    const late = await u.client.storage.from("submissions").upload(`${u.id}/late.txt`, Buffer.from("late"), { contentType: "text/plain" });
    expect(late.error).not.toBeNull();
    expect(storageCount([u.id])).toBe(0);

    // A server-side upload that was already past its auth check (e.g. an interview answer).
    await upload("interview-audio", `${u.id}/s1/turn-9.webm`, "audio", "audio/webm");
    expect(storageCount([u.id])).toBe(1);
    const next = await purgeDue(admin, { userIds: [u.id] });
    expect(next.outcomes).toEqual([]);
    expect(next.lateUploads.cleared).toBeGreaterThanOrEqual(1);
    expect(storageCount([u.id])).toBe(0);
    const { data: log } = await admin.from("purge_log").select("scope, detail").eq("user_id_hash", hashUserId(u.id)).order("purged_at");
    expect(log!.map((l) => l.scope)).toEqual(["candidate", "late_upload"]);
    expect(log![1].detail).toMatchObject({ storage_objects_deleted: { "interview-audio": 1 } });

    // Files under an id that was never purged (another account deleted by other means) are left alone.
    const stranger = randomUUID();
    await upload("cvs", `${stranger}/cv.pdf`, "%PDF-1.4", "application/pdf");
    try {
      await purgeDue(admin, { userIds: [stranger] });
      expect(storageCount([stranger])).toBe(1);
    } finally {
      await admin.storage.from("cvs").remove([`${stranger}/cv.pdf`]);
    }
  });

  it("keeps the queue current while purges are paused for a missing pepper", async () => {
    const u = await applicant("ret-nopepper");
    rejectAt(u.appId, boss.id, 2);
    backdate(u.id, 3);
    seed(`delete from public.retention_queue where user_id = '${u.id}';`);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("RETENTION_PEPPER", "");
    try {
      await expect(purgeDue(admin, { userIds: [u.id] })).rejects.toThrow(/RETENTION_PEPPER/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await queueRow(u.id))?.purge_after).toBe(purgeAfter(closedAtOf(u.appId), false));
  });

  it("archives decision reasons with e-mail addresses and phone numbers blanked", () => {
    expect(one(`select public.retention_scrub_reason('Spoke to jo.soap+x@mail.example.com and on +27 82 555 1234; quiz below the bar.')`)).toBe(
      "Spoke to [e-mail removed] and on [number removed]; quiz below the bar.",
    );
    expect(one(`select public.retention_scrub_reason('Below the bar on 2 of 4 topics (score 41/100).')`)).toBe("Below the bar on 2 of 4 topics (score 41/100).");
  });

  it("candidates and the public can't read the retention tables or run the purge functions", async () => {
    const cand = await newUser("ret-snoop");
    await consent(cand.client);
    const pub = anon();
    // The columns admins may read (the hashed keys are server-only).
    const readable: Record<string, string> = {
      retention_queue: "*",
      purge_log: "id, purged_at, scope, detail",
      decision_archive: "id, role_slug, stage, decision, reason, decided_at, archived_at",
      item_response_archive: "*",
    };
    for (const [table, cols] of Object.entries(readable)) {
      const c = await cand.client.from(table).select(cols).limit(5);
      expect(c.error, table).toBeNull();
      expect(c.data).toEqual([]);
      const a = await pub.from(table).select(cols).limit(5);
      expect(a.data ?? []).toEqual([]);
    }
    for (const client of [cand.client, pub, boss.client]) {
      const r = await client.from("retention_purges").select("user_id").limit(5);
      expect(r.data ?? []).toEqual([]);
      expect(r.error).not.toBeNull();
    }
    for (const [fn, args] of [
      ["refresh_retention_queue", {}],
      ["retention_schedule", { p_user_ids: [cand.id] }],
      ["retention_preview", { p_user_ids: [cand.id] }],
      ["retention_begin_purge", { p_user_id: cand.id, p_hash: "0".repeat(64), p_today: "2100-01-01" }],
      ["retention_note_progress", { p_user_id: cand.id, p_step: "auth" }],
      ["retention_cancel", { p_user_id: cand.id, p_reason: "x" }],
      ["retention_finish_purge", { p_user_id: cand.id }],
      ["retention_expire_archive", {}],
      ["retention_orphan_prefixes", {}],
      ["retention_in_progress", {}],
      ["retention_archive_lookup", { p_subject_hmac: "0".repeat(64) }],
      ["admin_lapse_applications", { p_application_ids: [randomUUID()], p_reason: "Not an admin, so this must fail." }],
      ["refresh_reasoning_item_stats", {}],
    ] as const) {
      const { error } = await cand.client.rpc(fn, args);
      expect(error, fn).not.toBeNull();
      const { error: anonErr } = await pub.rpc(fn, args);
      expect(anonErr, fn).not.toBeNull();
    }
    // Admins see the queue, the log's dates and counts and the archived decisions (read-only),
    // never the hashed keys, and still can't run a purge step directly.
    const { error: adminRead } = await boss.client.from("purge_log").select("id, purged_at, scope, detail").limit(1);
    expect(adminRead).toBeNull();
    for (const [table, col] of [["purge_log", "user_id_hash"], ["purge_log", "subject_hmac"], ["decision_archive", "user_id_hash"], ["decision_archive", "subject_hmac"]]) {
      const { error } = await boss.client.from(table).select(col).limit(1);
      expect(error, `${table}.${col}`).not.toBeNull();
    }
    const { error: progErr } = await boss.client.rpc("retention_in_progress");
    expect(progErr).toBeNull();
    const { error: adminRpc } = await boss.client.rpc("retention_begin_purge", { p_user_id: cand.id, p_hash: "0".repeat(64), p_today: "2100-01-01" });
    expect(adminRpc).not.toBeNull();
  });

  it("the daily sweep recomputes item statistics and runs the purge", async () => {
    const u = await fullCandidate("ret-sweep");
    process.env.CRON_SECRET ??= "test-cron-secret-123456";
    const run = async () => {
      const res = await sweep(new Request("http://localhost/api/cron/sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
      expect(res.status).toBe(200);
      return res.json();
    };
    let body = await run();
    expect(typeof body.itemStats).toBe("number");
    expect(typeof body.scoresUpdated).toBe("number");
    expect(body.retention).toMatchObject({ failed: 0, stoppedAtDeadline: false, remaining: 0 });
    expect(body.retention.purged).toBeGreaterThanOrEqual(1);
    expect(typeof body.retention.archiveExpired).toBe("number");
    expect(body.retention.lateUploads).toMatchObject({ checked: expect.any(Number), cleared: expect.any(Number) });
    expect(body.errors).toEqual([]);
    const { data: gone } = await admin.auth.admin.getUserById(u.id);
    expect(gone.user ?? null).toBeNull();
    const { data: log } = await admin.from("purge_log").select("detail").eq("user_id_hash", hashUserId(u.id)).single();
    expect(log!.detail).toMatchObject({ triggered_by: "sweep" });
    // No fixed count per run: everyone due is purged within the run's time (leftovers from
    // earlier test runs included), so a second run has nothing of this left.
    body = await run();
    expect(body.retention).toMatchObject({ failed: 0, remaining: 0, stoppedAtDeadline: false });
  }, 280_000);
});
