import { createClient } from "@/lib/supabase/server";
import RubricBreakdown from "@/components/admin/rubric-breakdown";

/** Rubric breakdown for every graded work submission on one application (admin only). */
export default async function WorkGrades({ applicationId }: { applicationId: string }) {
  const supabase = await createClient();
  const { data: attempts } = await supabase
    .from("work_attempts")
    .select("id, work_stages(key, title), submissions(id)")
    .eq("application_id", applicationId);
  const graded = (attempts ?? []).flatMap((a) => {
    const stage = a.work_stages as unknown as { key: string; title: string } | null;
    const subs = (a.submissions as unknown as { id: string }[] | { id: string } | null) ?? [];
    return (Array.isArray(subs) ? subs : [subs]).map((s) => ({ id: s.id, title: stage?.title ?? stage?.key ?? "Work" }));
  });
  if (!graded.length) return null;
  return (
    <div className="space-y-4">
      {graded.map((g) => (
        <div key={g.id} className="space-y-2">
          <h3 className="font-semibold">{g.title}: AI grading (advisory)</h3>
          <RubricBreakdown subjectType="submission" subjectId={g.id} />
        </div>
      ))}
    </div>
  );
}
