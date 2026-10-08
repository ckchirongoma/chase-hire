import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as sweep } from "@/app/api/cron/sweep/route";
import { hashUserId, listObjects, purgeDue, refreshRetentionQueue, retentionPepper } from "@/lib/server/retention";
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
afterAll(() => {
  if (!created.length) return;
  const ids = created.map((id) => `'${id}'`).join(",");
  // Candidates first: an admin can't go while their decisions (on those candidates) exist.
  psql(`delete from auth.users u where u.id in (${ids}) and not exists (select 1 from public.admins a where a.user_id = u.id);
        delete from auth.users where id in (${ids});`);
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
    backdate(open.id, 10); // old, but still in play

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

    // Item responses: 3 reasoning (unanswered counts as wrong) + 2 quiz, with a fresh attempt ref.
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

  it("candidates and the public can't read the retention tables or run the purge functions", async () => {
    const cand = await newUser("ret-snoop");
    await consent(cand.client);
    const pub = anon();
    for (const table of ["retention_queue", "purge_log", "decision_archive", "item_response_archive", "retention_purges"]) {
      const c = await cand.client.from(table).select("*").limit(5);
      expect(c.error).toBeNull();
      expect(c.data).toEqual([]);
      const a = await pub.from(table).select("*").limit(5);
      expect(a.data ?? []).toEqual([]);
    }
    for (const [fn, args] of [
      ["refresh_retention_queue", {}],
      ["retention_schedule", { p_user_ids: [cand.id] }],
      ["retention_preview", { p_user_ids: [cand.id] }],
      ["retention_begin_purge", { p_user_id: cand.id, p_hash: "0".repeat(64), p_today: "2100-01-01" }],
      ["retention_note_progress", { p_user_id: cand.id, p_step: "auth" }],
      ["retention_finish_purge", { p_user_id: cand.id }],
      ["refresh_reasoning_item_stats", {}],
    ] as const) {
      const { error } = await cand.client.rpc(fn, args);
      expect(error, fn).not.toBeNull();
      const { error: anonErr } = await pub.rpc(fn, args);
      expect(anonErr, fn).not.toBeNull();
    }
    // Admins see the queue and the log (read-only), and still can't run a purge step directly.
    const { error: adminRead } = await boss.client.from("purge_log").select("id").limit(1);
    expect(adminRead).toBeNull();
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
    expect(body.retention).toMatchObject({ failed: 0 });
    expect(body.retention.purged).toBeGreaterThanOrEqual(1);
    expect(body.errors).toEqual([]);
    // Bounded per run: leftovers from earlier test runs may need another pass.
    for (let i = 0; i < 4 && body.retention.remaining > 0; i++) body = await run();
    const { data: gone } = await admin.auth.admin.getUserById(u.id);
    expect(gone.user ?? null).toBeNull();
    const { data: log } = await admin.from("purge_log").select("detail").eq("user_id_hash", hashUserId(u.id)).single();
    expect(log!.detail).toMatchObject({ triggered_by: "sweep" });
  });
});
