-- Wave 2 interview extras (re-runnable).
--
-- 1. One stored answer per turn. The server stores the candidate's answer FIRST (so the DB
--    timestamps it inside the deadline, whatever JEV does afterwards) and the unique index
--    turns a re-sent or second-tab answer for the same turn into a clean conflict.
-- 2. interview_advance(): moves the script cursor and stores the interviewer's reply in one
--    transaction (compare-and-set on progress.turn), so a crash can't leave one without the other.
-- 3. A human override on an interview criterion (grade_summaries.human_score) keeps
--    final_score = coalesce(human_score, median_score), clears needs_human_review, and
--    recomputes interview_sessions.score, which my_results() and application_scores() read.

-- ───────────────────────── 1. One answer per turn ─────────────────────────
create unique index if not exists interview_messages_candidate_turn_uidx
  on public.interview_messages (session_id, (meta ->> 'turn'))
  where role = 'candidate';

-- ───────────────────────── 2. Atomic cursor move + replies ─────────────────────────
create or replace function public.interview_advance(
  p_session_id uuid,
  p_from_turn int,
  p_progress jsonb,
  p_messages jsonb,
  p_candidate_message_id uuid,
  p_candidate_meta jsonb
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.interview_sessions
     set progress = p_progress
   where id = p_session_id
     and ended_at is null
     and (progress ->> 'turn')::int = p_from_turn;
  if not found then
    return false;
  end if;

  if p_candidate_message_id is not null then
    update public.interview_messages
       set meta = meta || coalesce(p_candidate_meta, '{}'::jsonb)
     where id = p_candidate_message_id
       and session_id = p_session_id
       and role = 'candidate';
  end if;

  insert into public.interview_messages (session_id, role, content, step, claim_id, meta)
  select p_session_id, 'interviewer', m ->> 'content', m ->> 'step', m ->> 'claim_id', coalesce(m -> 'meta', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as m;

  return true;
end;
$$;
revoke execute on function public.interview_advance(uuid, int, jsonb, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.interview_advance(uuid, int, jsonb, jsonb, uuid, jsonb) to service_role;

-- ───────────────────────── 3. Human overrides on interview criteria ─────────────────────────
create or replace function public.interview_summary_human_override()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_type = 'interview' and new.human_score is distinct from old.human_score then
    new.final_score := coalesce(new.human_score, new.median_score);
    if new.human_score is not null then
      new.needs_human_review := false;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists grade_summaries_interview_override on public.grade_summaries;
create trigger grade_summaries_interview_override
  before update on public.grade_summaries
  for each row execute function public.interview_summary_human_override();

-- Same formula as lib/grading (criterionTo100 + weightedMean): weighted mean of
-- (final − 1) / 4 × 100 over criteria with a final score, rounded to 0.1.
create or replace function public.interview_rescore_from_summaries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.interview_sessions s
     set score = (
       select round(
                case when sum(greatest(g.weight, 0)) > 0
                     then sum((g.final_score - 1) / 4 * 100 * greatest(g.weight, 0)) / sum(greatest(g.weight, 0))
                     else avg((g.final_score - 1) / 4 * 100) end, 1)
         from public.grade_summaries g
        where g.subject_type = 'interview' and g.subject_id = s.id and g.final_score is not null)
   where s.id = new.subject_id
     and s.ended_at is not null
     and s.summary is not null;  -- not graded yet: the grading handler writes the first score
  return null;
end;
$$;
drop trigger if exists grade_summaries_interview_rescore on public.grade_summaries;
create trigger grade_summaries_interview_rescore
  after update of human_score, final_score on public.grade_summaries
  for each row
  when (new.subject_type = 'interview'
        and (new.human_score is distinct from old.human_score or new.final_score is distinct from old.final_score))
  execute function public.interview_rescore_from_summaries();

revoke execute on function public.interview_summary_human_override() from public, anon, authenticated;
revoke execute on function public.interview_rescore_from_summaries() from public, anon, authenticated;

notify pgrst, 'reload schema';
