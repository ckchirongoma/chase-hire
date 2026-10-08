import { beforeAll, describe, expect, it } from "vitest";
import { answerQuiz, startQuiz, type QuizState } from "@/lib/server/quiz";
import { MyResults } from "@/components/results/schema";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

const admin = service();
const BA = "business-analyst";

type Applicant = Awaited<ReturnType<typeof newUser>> & { appId: string };

async function applicant(tag: string, role: string): Promise<Applicant> {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: role });
  if (error) throw error;
  return { ...u, appId: data as string };
}

function moveToQuiz(appId: string) {
  psql(`alter table public.applications disable trigger applications_status_guard;
        update public.applications set stage = 'quiz', status = 'in_progress' where id = '${appId}';
        alter table public.applications enable trigger applications_status_guard;`);
}

const SECRETS = ["SECRET-PLAN", "SECRET-CONCERN", "SECRET-EVIDENCE", "SECRET-RATIONALE", "SECRET-REVIEW-REASON", "SECRET-TRANSCRIPT"];

let a: Applicant, b: Applicant;

beforeAll(async () => {
  [a, b] = await Promise.all([applicant("results-a", BA), applicant("results-b", BA)]);

  // A finished, graded interview for A, with admin-only material planted everywhere.
  const { data: rubric } = await admin.from("rubrics").select("id").eq("key", "interview").eq("version", 1).single();
  const { data: session, error } = await admin
    .from("interview_sessions")
    .insert({ application_id: a.appId, user_id: a.id, plan: { note: "SECRET-PLAN" }, deadline_at: new Date(Date.now() + 60_000).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  await admin.from("interview_messages").insert({ session_id: session!.id, role: "candidate", content: "SECRET-TRANSCRIPT" });
  const ended = await admin
    .from("interview_sessions")
    .update({
      ended_at: new Date().toISOString(),
      end_reason: "completed",
      score: 72,
      summary: { verification_concerns: ["SECRET-CONCERN"] },
      model: "stub/grader",
      prompt_version: "interview-grader.v1",
    })
    .eq("id", session!.id);
  if (ended.error) throw ended.error;
  const grade = await admin.from("grades").insert({
    subject_type: "interview",
    subject_id: session!.id,
    rubric_id: rubric!.id,
    criterion_key: "specificity",
    sample_idx: 0,
    score: 4,
    evidence: [{ quote: "SECRET-EVIDENCE", location: "turn 3" }],
    rationale: "SECRET-RATIONALE",
    model: "stub/grader",
    prompt_version: "interview-grader.v1",
    temperature: 0,
  });
  if (grade.error) throw grade.error;
  const summaries = await admin.from("grade_summaries").insert([
    {
      subject_type: "interview", subject_id: session!.id, rubric_id: rubric!.id, criterion_key: "specificity",
      weight: 1, median_score: 4, spread: 0, needs_human_review: false, review_reason: null,
      final_score: 4, feedback: "Concrete examples with numbers.",
    },
    {
      subject_type: "interview", subject_id: session!.id, rubric_id: rubric!.id, criterion_key: "ownership",
      weight: 1, median_score: 3, spread: 2, needs_human_review: true, review_reason: "SECRET-REVIEW-REASON",
      final_score: null, feedback: null,
    },
  ]);
  if (summaries.error) throw summaries.error;

  // A's role quiz: one correct answer, the rest skipped.
  moveToQuiz(a.appId);
  let s = (await startQuiz(admin, a.id, BA)) as Extract<QuizState, { status: "active" }>;
  for (let pos = 1; pos <= 15; pos++) {
    const { data } = await admin.from("quiz_responses").select("answer_key").eq("attempt_id", s.attemptId).eq("position", pos).single();
    const next = await answerQuiz(admin, a.id, BA, s.attemptId, pos, pos === 1 ? data!.answer_key : null);
    if (next.status === "active") s = next;
  }

  // An admin hold with a written reason.
  const reviewer = await newUser("results-admin");
  await makeAdmin(reviewer.id);
  const decided = await reviewer.client.rpc("admin_decide", {
    p_application_id: a.appId,
    p_decision: "hold",
    p_reason: "Holding while we check the ownership score by hand.",
  });
  if (decided.error) throw decided.error;
});

describe("my_results()", () => {
  it("returns only the caller's own applications", async () => {
    const ra = await a.client.rpc("my_results");
    const rb = await b.client.rpc("my_results");
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
    expect(ra.data.map((x: { application_id: string }) => x.application_id)).toEqual([a.appId]);
    expect(rb.data.map((x: { application_id: string }) => x.application_id)).toEqual([b.appId]);
    expect(JSON.stringify(rb.data)).not.toContain(a.appId);
  });

  it("shows candidate-safe scores, feedback, review flags and decision reasons", async () => {
    const { data } = await a.client.rpc("my_results");
    const [app] = MyResults.parse(data);
    expect(app).toMatchObject({ role_slug: BA, stage: "quiz", status: "awaiting_review", below_hurdle: false });
    expect(app!.interview).toMatchObject({ end_reason: "completed", score: 72 });
    const byKey = Object.fromEntries(app!.interview!.criteria.map((c) => [c.key, c]));
    expect(byKey.specificity).toEqual({ key: "specificity", final_score: 4, feedback: "Concrete examples with numbers.", under_review: false });
    expect(byKey.ownership).toMatchObject({ final_score: null, under_review: true });
    expect(app!.quiz).toMatchObject({ raw_score: 1, pct: 6.7 });
    expect(Object.values(app!.quiz!.topic_scores!).reduce((n, t) => n + t.total, 0)).toBe(15);
    expect(app!.decisions).toEqual([
      expect.objectContaining({ stage: "quiz", decision: "hold", reason: "Holding while we check the ownership score by hand." }),
    ]);
  });

  it("never includes evidence, rationales, transcripts, verification concerns, answer keys or flags", async () => {
    const { data } = await a.client.rpc("my_results");
    const text = JSON.stringify(data);
    for (const s of SECRETS) expect(text).not.toContain(s);
    for (const field of ["answer_key", "evidence", "rationale", "verification", "summary", "plan", "seed", "below_flag", "review_reason", "spread", "median_score", "decided_by", "scores_snapshot"]) {
      expect(text, field).not.toContain(`"${field}`);
    }
  });

  it("the underlying admin tables stay closed to the candidate", async () => {
    for (const table of ["interview_sessions", "interview_messages", "grades", "grade_summaries", "quiz_attempts", "quiz_responses"]) {
      const { data, error } = await a.client.from(table).select("*").limit(5);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it("is not callable anonymously", async () => {
    const { error } = await anon().rpc("my_results");
    expect(error).not.toBeNull();
  });

  it("lets the candidate ask for a review of the quiz or interview for their own application only", async () => {
    const ok = await a.client.from("review_requests").insert({ stage: "quiz", application_id: a.appId, message: "Please re-check question 4." });
    expect(ok.error).toBeNull();
    const other = await b.client.from("review_requests").insert({ stage: "interview", application_id: a.appId, message: "Not my application." });
    expect(other.error).not.toBeNull();
  });
});
