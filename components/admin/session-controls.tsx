import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";

/**
 * Admin controls for the tab rule and the interview accommodation:
 * - reopen a locked reasoning test, role quiz or interview (the candidate keeps the time
 *   they had left when it locked; a lock is never a rejection);
 * - let one application answer the interview by typing instead of speaking (before it starts).
 * Both need a written reason, stored with the change.
 */

const KIND_LABEL = { reasoning: "Reasoning Assessment", quiz: "Role quiz", interview: "AI CV interview" } as const;
type Kind = keyof typeof KIND_LABEL;

const Reopen = z.object({
  user_id: z.uuid(),
  kind: z.enum(["reasoning", "quiz", "interview"]),
  id: z.uuid(),
  reason: z.string().trim().min(20, "Give a reason of at least 20 characters."),
});

async function reopen(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const parsed = Reopen.safeParse(Object.fromEntries(formData));
  const uid = String(formData.get("user_id"));
  if (!parsed.success) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { error } = await supabase.rpc("admin_reopen_session", {
    p_kind: parsed.data.kind,
    p_id: parsed.data.id,
    p_reason: parsed.data.reason,
  });
  if (error) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(error.message)}`);
  redirect(`/admin/candidates/${uid}?ok=reopened`);
}

const Mode = z.object({
  user_id: z.uuid(),
  application_id: z.uuid(),
  mode: z.enum(["voice", "typed"]),
  reason: z.string().trim().min(20, "Give a reason of at least 20 characters."),
});

async function setMode(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const parsed = Mode.safeParse(Object.fromEntries(formData));
  const uid = String(formData.get("user_id"));
  if (!parsed.success) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { error } = await supabase.rpc("admin_set_interview_mode", {
    p_application_id: parsed.data.application_id,
    p_mode: parsed.data.mode,
    p_reason: parsed.data.reason,
  });
  if (error) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(error.message)}`);
  redirect(`/admin/candidates/${uid}?ok=mode`);
}

type Locked = { kind: Kind; id: string; locked_at: string; lock_reason: string | null; deadline_at: string; tab_leaves: number };
type App = { id: string; stage: string; interview_answer_mode: string; interview_mode_reason: string | null; roles: { title: string } | null };

export default async function SessionControls({ userId }: { userId: string }) {
  const { supabase } = await requireAdmin();
  const cols = "id, locked_at, lock_reason, deadline_at, tab_leaves";
  const [r, q, i, apps, sessions] = await Promise.all([
    supabase.from("reasoning_attempts").select(cols).eq("user_id", userId).not("locked_at", "is", null).is("submitted_at", null),
    supabase.from("quiz_attempts").select(cols).eq("user_id", userId).not("locked_at", "is", null).is("submitted_at", null),
    supabase.from("interview_sessions").select(cols).eq("user_id", userId).not("locked_at", "is", null).is("ended_at", null),
    supabase.from("applications").select("id, stage, interview_answer_mode, interview_mode_reason, roles(title)").eq("user_id", userId),
    supabase.from("interview_sessions").select("application_id").eq("user_id", userId),
  ]);
  const locked: Locked[] = [
    ...((r.data ?? []) as Omit<Locked, "kind">[]).map((x) => ({ ...x, kind: "reasoning" as const })),
    ...((q.data ?? []) as Omit<Locked, "kind">[]).map((x) => ({ ...x, kind: "quiz" as const })),
    ...((i.data ?? []) as Omit<Locked, "kind">[]).map((x) => ({ ...x, kind: "interview" as const })),
  ];
  const started = new Set((sessions.data ?? []).map((s) => s.application_id as string));
  const open = ((apps.data ?? []) as unknown as App[]).filter((a) => !started.has(a.id) && ["cv", "reasoning", "interview"].includes(a.stage));

  return (
    <section className="card space-y-3" data-testid="session-controls">
      <h2 className="h2">Locked sessions and interview accommodation</h2>
      {locked.length ? (
        locked.map((l) => {
          const leftMs = new Date(l.deadline_at).getTime() - new Date(l.locked_at).getTime();
          return (
            <div key={l.id} className="rounded border border-amber-300 p-3 text-sm">
              <p>
                <strong>{KIND_LABEL[l.kind]}</strong> locked {fmtDate(l.locked_at)} after {l.tab_leaves} tab leaves
                {l.lock_reason && <> ({l.lock_reason})</>}. Time left when it locked: {Math.max(1, Math.round(leftMs / 60_000))} min
                (at least 1 minute is given back).
              </p>
              <form action={reopen} className="mt-2 flex flex-wrap items-start gap-2">
                <input type="hidden" name="user_id" value={userId} />
                <input type="hidden" name="kind" value={l.kind} />
                <input type="hidden" name="id" value={l.id} />
                <textarea name="reason" required minLength={20} rows={2} className="input flex-1" placeholder="Why it is fair to reopen (min 20 characters)" />
                <button className="btn">Reopen</button>
              </form>
            </div>
          );
        })
      ) : (
        <p className="muted">No locked sessions.</p>
      )}
      {open.map((a) => (
        <div key={a.id} className="rounded border border-slate-200 p-3 text-sm">
          <p>
            <strong>{a.roles?.title}</strong>: interview answers are{" "}
            {a.interview_answer_mode === "typed" ? <span className="badge">typed (accommodation)</span> : "spoken"}
            {a.interview_mode_reason && <span className="muted"> · {a.interview_mode_reason}</span>}
          </p>
          <form action={setMode} className="mt-2 flex flex-wrap items-start gap-2">
            <input type="hidden" name="user_id" value={userId} />
            <input type="hidden" name="application_id" value={a.id} />
            <select name="mode" className="input w-40" defaultValue={a.interview_answer_mode === "typed" ? "voice" : "typed"}>
              <option value="typed">Typed answers</option>
              <option value="voice">Spoken answers</option>
            </select>
            <textarea name="reason" required minLength={20} rows={2} className="input flex-1" placeholder="Reason, e.g. the accommodation requested (min 20 characters)" />
            <button className="btn-secondary">Set answer mode</button>
          </form>
        </div>
      ))}
    </section>
  );
}
