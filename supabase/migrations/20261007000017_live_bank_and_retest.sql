-- Live stage bank and reasoning retest (docs/01 "live", docs/04 §2 and §6, docs/09 §2, §5 and §8).
--
-- 1. live_questions: the anchored bank for every live scorecard. Panel interview: 6 fixed
--    questions per role (docs/09 §5), two of which are "replaceable" slots that the admin UI fills
--    with questions built from the candidate's AI-interview verification_concerns (falling back to
--    the bank question when there are fewer than two concerns). Live defence: 4 per role (incl. the
--    SWE "AI-off" debugging task). Live elicitation: 4 for BA (a human plays a new client).
--    Exec scenario: 3 for SWE ("Lerato asks for something unreasonable").
--    Anchors are behavioural, at 1 / 3 / 5 (2 and 4 are in between). Live communication anchors
--    use E1, E5, E7 and E8 only (docs/09 §4); appearance, accent and fluency are never scored.
-- 2. reasoning_items form='live': the parallel-form pool for the 12-item / 6-minute paper retest,
--    the same 6 families x 3 tiers as the online templates, so lib/reasoning's seeded generators
--    render it (lib/live/retest.ts). Live norms are code constants (lib/live/retest.ts), like the
--    online provisional norm.
-- 3. calibration_runs: which rubric version and which gold samples a run graded.
-- 4. live_scorecards guards: a submitted scorecard has a total; a submitted reasoning retest has
--    a raw score of 0..12. The retest is never part of the composite (docs/09 §2).
--
-- Re-runnable: inserts skip existing rows, so admin edits to the bank are never overwritten.

-- ───────────────────────── Live question bank ─────────────────────────
alter table public.live_questions add column if not exists replaceable boolean not null default false;
comment on column public.live_questions.replaceable is
  'Panel interview slot that a question built from the candidate''s AI-interview verification concern replaces (docs/09 §5).';
grant update (replaceable) on public.live_questions to authenticated;

insert into public.live_questions (role_slug, kind, key, position, text, probes, anchors, replaceable) values
-- BA: structured panel interview (docs/03 §2 competencies B1-B8)
('business-analyst', 'panel_interview', 'ba_panel_data_problem', 1,
 $t$Tell me about a time you found a problem in data that others had missed.$t$,
 array[$p$How did you spot it? What made you look there?$p$,
       $p$What exactly did you do about it, personally?$p$,
       $p$What was the impact, in numbers (rands, hours, records)?$p$,
       $p$What changed afterwards, so it didn't happen again?$p$],
 jsonb_build_object(
   '1', $a$Vague, or describes someone else's work$a$,
   '3', $a$A specific instance; describes the finding; limited impact or follow-through$a$,
   '5', $a$Specific; explains how they spotted it, what they did, quantified the impact, and what changed afterwards$a$),
 false),
('business-analyst', 'panel_interview', 'ba_panel_hidden_need', 2,
 $t$Tell me about a time a stakeholder asked for one thing but actually needed something else. How did you find out?$t$,
 array[$p$Which questions surfaced the real need?$p$,
       $p$How did you confirm your understanding back to them?$p$,
       $p$What would have happened if you had built what they first asked for?$p$,
       $p$How did they react when you pushed back?$p$],
 jsonb_build_object(
   '1', $a$Built what was asked, or can't describe how the real need surfaced$a$,
   '3', $a$Noticed the gap, but the technique is vague ("I asked more questions") and nothing was confirmed back$a$,
   '5', $a$Names the questions or technique that surfaced the hidden constraint, confirmed understanding back, and shows what reframing the request achieved$a$),
 false),
('business-analyst', 'panel_interview', 'ba_panel_said_no', 3,
 $t$Tell me about a time you recommended NOT building something a client or manager wanted.$t$,
 array[$p$What evidence was the recommendation based on?$p$,
       $p$What was the strongest argument against your position?$p$,
       $p$What did you recommend instead?$p$,
       $p$What happened in the end, and would you do it again?$p$],
 jsonb_build_object(
   '1', $a$No real example, or went along with the request without taking a position$a$,
   '3', $a$Took a position with some reasoning, but the evidence is thin or the alternative unclear$a$,
   '5', $a$A clear, evidence-backed position; states the strongest counter-argument and why it lost there; proposes what to do instead and can describe the outcome$a$),
 false),
('business-analyst', 'panel_interview', 'ba_panel_spec_built', 4,
 $t$Tell me about requirements or a spec you wrote that a developer built from. What went wrong, and what did you change?$t$,
 array[$p$Give us one acceptance criterion you wrote. What made it testable?$p$,
       $p$Which edge case or business rule did you miss?$p$,
       $p$Who could see and do what? How did you specify access?$p$,
       $p$What do you do differently now?$p$],
 jsonb_build_object(
   '1', $a$Generic description of "writing requirements"; can't name a gap or a change$a$,
   '3', $a$A real spec with some testable criteria; names a gap, but the lesson is general$a$,
   '5', $a$A concrete spec with testable acceptance criteria, rules, edge cases and access; names the specific gap that slipped through and the change it led to$a$),
 false),
('business-analyst', 'panel_interview', 'ba_panel_research', 5,
 $t$Tell me about a time outside research (law, platform rules, benchmarks) changed what you recommended.$t$,
 array[$p$Which source, and how did you judge that it was reliable?$p$,
       $p$What did you filter out as noise?$p$,
       $p$How did it connect to that particular business?$p$,
       $p$What would have gone wrong without it?$p$],
 jsonb_build_object(
   '1', $a$No example, or research that changed nothing$a$,
   '3', $a$Cites a relevant source, but the link to the recommendation is loose$a$,
   '5', $a$A specific source judged for reliability, applied to that business's own facts, and it clearly changed the recommendation$a$),
 true),
('business-analyst', 'panel_interview', 'ba_panel_ai_checked', 6,
 $t$Walk us through a piece of work where you used AI tools heavily. What did the AI do, what did you do, and how did you check it?$t$,
 array[$p$Which output did you not trust, and why?$p$,
       $p$How did you verify a number or a claim the AI produced?$p$,
       $p$Which insight was yours rather than the tool's?$p$,
       $p$What do you never delegate to AI?$p$],
 jsonb_build_object(
   '1', $a$Can't separate their own work from the tool's, or did no checking$a$,
   '3', $a$Uses AI sensibly with some checking, but verification is ad hoc$a$,
   '5', $a$A clear split between AI drafting or extraction and their own insight; a concrete verification step that caught a real error$a$),
 true),

-- SWE: structured panel interview (docs/03 §3 competencies S1-S9)
('software-engineer', 'panel_interview', 'swe_panel_incident', 1,
 $t$Tell me about a production problem you caused or found. How did you find it, fix it, and stop it recurring?$t$,
 array[$p$How did you find out: monitoring, a user, or luck?$p$,
       $p$What did you personally do in the first hour?$p$,
       $p$What was the root cause?$p$,
       $p$What did you change so it can't happen again (a test, an alert, a process)?$p$],
 jsonb_build_object(
   '1', $a$Vague, blames others, or no real incident$a$,
   '3', $a$A real incident and fix; the root cause or the prevention is thin$a$,
   '5', $a$Specific detection, their own actions, the root cause, and a lasting prevention (test, alert, rollback) with its impact$a$),
 false),
('software-engineer', 'panel_interview', 'swe_panel_security_gap', 2,
 $t$Tell me about a security or access-control gap you found in a system, yours or someone else's.$t$,
 array[$p$How did you find it without being told where to look?$p$,
       $p$Who could see or do something they shouldn't have?$p$,
       $p$How did you fix it at the database or API level, not just in the UI?$p$,
       $p$How did you prove the fix worked?$p$],
 jsonb_build_object(
   '1', $a$No example, or the "fix" only hid something in the UI$a$,
   '3', $a$A real gap fixed, but the enforcement or the proof is partial$a$,
   '5', $a$Found it proactively, fixed it where it is enforced (DB policy, API), proved it with a test, and explains least privilege$a$),
 false),
('software-engineer', 'panel_interview', 'swe_panel_messy_data', 3,
 $t$Tell me about a data import or pipeline that had to survive messy or changing input.$t$,
 array[$p$How did you make re-runs safe?$p$,
       $p$What did you do with rows you couldn't trust?$p$,
       $p$What happened when the file's structure changed?$p$,
       $p$How did you normalise identifiers such as phone numbers, dates and keys?$p$],
 jsonb_build_object(
   '1', $a$Happy-path import only; no handling of bad rows or re-runs$a$,
   '3', $a$Some validation and cleaning; re-runs or schema drift handled loosely$a$,
   '5', $a$Idempotent, normalises keys, quarantines bad rows visibly, fails loudly on schema drift, and explains the trade-offs$a$),
 false),
('software-engineer', 'panel_interview', 'swe_panel_build_vs_buy', 4,
 $t$Tell me about a time you chose to use a service instead of building it yourself, or the other way round. How did you cost it?$t$,
 array[$p$What were the cost drivers and assumptions?$p$,
       $p$What would make you reverse the decision?$p$,
       $p$What did it cost in people-time to maintain?$p$,
       $p$How did you explain the choice to a non-technical decision maker?$p$],
 jsonb_build_object(
   '1', $a$Decided by preference; no costs or alternatives$a$,
   '3', $a$Compared options with rough costs; assumptions or risks are thin$a$,
   '5', $a$Costed the options (in rands) with stated assumptions and drivers, named the risks, and the condition that would reverse the decision$a$),
 false),
('software-engineer', 'panel_interview', 'swe_panel_ai_wrong', 5,
 $t$Tell me about a time an AI tool gave you code that looked right but was wrong. How did you catch it?$t$,
 array[$p$What exactly was wrong?$p$,
       $p$Which check or test caught it?$p$,
       $p$How do you review AI-written code now?$p$,
       $p$Could you explain every line you shipped?$p$],
 jsonb_build_object(
   '1', $a$Trusts AI output, or no example$a$,
   '3', $a$Caught an error, but by chance or late$a$,
   '5', $a$Systematic verification (tests, reading, running it) that caught a subtle error; explains the fix line by line$a$),
 true),
('software-engineer', 'panel_interview', 'swe_panel_explain_risk', 6,
 $t$Tell me about a time you explained a technical risk to a non-technical decision maker. What did you say, and what did they decide?$t$,
 array[$p$What was your first sentence?$p$,
       $p$How did you put it in business terms (money, customers, time)?$p$,
       $p$What options did you give them?$p$,
       $p$What did they decide, and what happened?$p$],
 jsonb_build_object(
   '1', $a$Jargon, no clear ask, or no example$a$,
   '3', $a$Explained the risk understandably, but gave no options or clear ask$a$,
   '5', $a$Answer first, translated into business impact, options with trade-offs and a clear ask, and the decision followed$a$),
 true),

-- BA: live defence of their own work (docs/06 "Live stage"; doc 09 §4 E7-E8)
('business-analyst', 'live_defence', 'ba_defence_counter_evidence', 1,
 $t$Unseen counter-evidence: "Lerato says the Network will supply phone numbers for the whole base next quarter." Does your Spiky POV still hold?$t$,
 array[$p$What changes in your recommendation, and what doesn't?$p$,
       $p$What evidence would you ask her for before believing it?$p$,
       $p$What would you do in the meantime?$p$],
 jsonb_build_object(
   '1', $a$Folds immediately or gets defensive; no reasoning$a$,
   '3', $a$Holds the position without new reasoning, or changes it without saying why$a$,
   '5', $a$Holds with evidence or updates with a stated reason; separates what changes from what doesn't; asks for the evidence that would decide it$a$),
 false),
('business-analyst', 'live_defence', 'ba_defence_falsify', 2,
 $t$Which fact, if we showed it to you now, would make you drop your strongest POV?$t$,
 array[$p$How would you check that fact in the client's data?$p$,
       $p$Which of your POVs is the weakest, and why?$p$],
 jsonb_build_object(
   '1', $a$Can't name one, or says nothing would change their mind$a$,
   '3', $a$Names a plausible fact but can't say how to check it$a$,
   '5', $a$Names a specific, checkable fact tied to the data (sheet, column, figure) and how to test it; ranks their own POVs honestly$a$),
 false),
('business-analyst', 'live_defence', 'ba_defence_handoff', 3,
 $t$An engineer reads your handoff and asks: one company has 12 accounts and two agents. Who sees what, and where does your spec say so?$t$,
 array[$p$Where are the grain and the key for this in your data model?$p$,
       $p$What does your access matrix say for a manager and for an agent?$p$,
       $p$What is out of scope, and why?$p$],
 jsonb_build_object(
   '1', $a$Can't find it in their own spec and answers from scratch$a$,
   '3', $a$Partly covered; resolves the rest on the spot, reasonably$a$,
   '5', $a$Points to the exact rule, key and access row in their handoff, or names the gap honestly with the fix$a$),
 false),
('business-analyst', 'live_defence', 'ba_defence_ai_use', 4,
 $t$Which parts of your memo did AI draft, and which insight is yours? Show us one number you checked yourself.$t$,
 array[$p$How did you check it?$p$,
       $p$What did the AI get wrong?$p$,
       $p$Would you put that output in front of a client?$p$],
 jsonb_build_object(
   '1', $a$Can't separate their own insight from AI output, or can't reproduce any figure$a$,
   '3', $a$Describes the split, but the verification is vague$a$,
   '5', $a$A clear split; reproduces a figure from the data and names an AI error they caught$a$),
 false),

-- SWE: live defence (docs/07 "Live defence", AI off for the debugging part; docs/08 for Test 2)
('software-engineer', 'live_defence', 'swe_defence_rls', 1,
 $t$Walk us through your RLS policies. What does agent A see if we add a shared-account feature tomorrow?$t$,
 array[$p$Which policy decides that, and where is it enforced?$p$,
       $p$What would you change, and how would you test it?$p$,
       $p$What does the service-role key bypass?$p$],
 jsonb_build_object(
   '1', $a$Can't explain their own policies, or relies on the UI$a$,
   '3', $a$Explains the policies; the shared-account case is only partly reasoned$a$,
   '5', $a$Explains each policy and where it is enforced, reasons the new case correctly, and proposes the migration and the test$a$),
 false),
('software-engineer', 'live_defence', 'swe_defence_ai_off_debug', 2,
 $t$AI off: we have introduced a bug into your deployed branch (a policy change or an off-by-one in the date window). Find it and explain it.$t$,
 array[$p$How are you narrowing it down?$p$,
       $p$How would you prove the fix?$p$,
       $p$Which test or alert would have caught it?$p$],
 jsonb_build_object(
   '1', $a$Can't find it without AI, or guesses at random$a$,
   '3', $a$Finds it with hints, or finds it but can't explain the cause$a$,
   '5', $a$Finds it methodically (reproduce, narrow, read), explains the root cause, fixes it, and names the test that would catch it next time$a$),
 false),
('software-engineer', 'live_defence', 'swe_defence_architecture', 3,
 $t$Your Test 2 vendor quote just came back at three times your estimate. What changes in your plan and your cost model?$t$,
 array[$p$Which assumption moved, and what does the sensitivity look like?$p$,
       $p$What would you cut, or phase differently?$p$,
       $p$What is the kill criterion now?$p$],
 jsonb_build_object(
   '1', $a$Starts again from scratch, or defends the old number$a$,
   '3', $a$Adjusts the budget but not the plan$a$,
   '5', $a$Traces which drivers and assumptions change, re-phases with a kill criterion, and states the new cost in rands with the exchange rate used$a$),
 false),
('software-engineer', 'live_defence', 'swe_defence_tradeoffs', 4,
 $t$What did you defer or leave out of your submissions, and why was that the right call?$t$,
 array[$p$What is the risk of what you deferred?$p$,
       $p$What would you do with one more day?$p$,
       $p$What did you get wrong?$p$],
 jsonb_build_object(
   '1', $a$No deliberate prioritisation ("I ran out of time")$a$,
   '3', $a$Lists what was deferred, with some reasoning$a$,
   '5', $a$Prioritised by risk and value, owns what they got wrong, and has a clear next step$a$),
 false),

-- BA: live elicitation role-play (docs/06 "Live stage" item 3): a NEW scenario played by a person
('business-analyst', 'live_elicitation', 'ba_elicit_technique', 1,
 $t$Role-play: a panellist plays Thandi, head of royalties at an independent music label, who opens with "We need a dashboard for our royalties." Score how the candidate chooses and runs their approach.$t$,
 array[$p$Did they ask which decision the dashboard would support?$p$,
       $p$Did they ask to see a real statement or spreadsheet?$p$,
       $p$Did they choose a technique on purpose (e.g. a walk-through of the last payment run)?$p$],
 jsonb_build_object(
   '1', $a$Jumps to solutions (charts, tools) or asks leading questions$a$,
   '3', $a$Reasonable open questions, but no clear funnel or technique$a$,
   '5', $a$Opens broad, funnels on purpose, asks for real examples and artefacts, and steers to the decision behind the request$a$),
 false),
('business-analyst', 'live_elicitation', 'ba_elicit_probing', 2,
 $t$Probing: did the candidate dig beneath the first answers to find the hidden constraints?$t$,
 array[$p$Did they ask about data sources, owners and formats?$p$,
       $p$Did they ask about history ("what happened last time?") and incentives?$p$,
       $p$Did they ask about sign-off, audit or legal constraints?$p$],
 jsonb_build_object(
   '1', $a$Accepts first answers at face value$a$,
   '3', $a$Some follow-up, mostly on what Thandi volunteers$a$,
   '5', $a$Follows up every vague answer; asks about sources, ownership, history, incentives and constraints without being led$a$),
 false),
('business-analyst', 'live_elicitation', 'ba_elicit_confirm', 3,
 $t$Confirming back: did the candidate summarise, check their understanding and reframe the request?$t$,
 array[$p$Did they play the problem back in their own words?$p$,
       $p$Did they say what they think the real problem is (it isn't the dashboard)?$p$,
       $p$Did they agree next steps and what they need from Thandi?$p$],
 jsonb_build_object(
   '1', $a$Never summarises or confirms$a$,
   '3', $a$Summarises at the end, mostly restating the request$a$,
   '5', $a$Confirms back at key points, reframes the request into the real problem, and agrees next steps$a$),
 false),
('business-analyst', 'live_elicitation', 'ba_elicit_yield', 4,
 $t$Yield: how many of the 8 hidden facts did the candidate surface? Thandi reveals a fact only when asked about it (the probes list them).$t$,
 array[$p$H1 Statements arrive from three distributors in different formats (CSV, XLSX, PDF), some monthly, some quarterly.$p$,
       $p$H2 Co-writer splits live in one spreadsheet kept by one person, who leaves in March.$p$,
       $p$H3 About a fifth of the older catalogue has no ISRC, so those statement lines can't be matched.$p$,
       $p$H4 Some statements are in USD or EUR, and each distributor converts at a different rate.$p$,
       $p$H5 Advances are recouped by hand in a separate workbook; two artists dispute their balances.$p$,
       $p$H6 The real pain is three weeks of reconciliation before each payment run, not the lack of a dashboard.$p$,
       $p$H7 The finance director must sign off every artist statement before it is released (audit requirement).$p$,
       $p$H8 Artists are paid twice a year, and complaints spike after every run.$p$],
 jsonb_build_object(
   '1', $a$0-2 of the 8 facts$a$,
   '3', $a$About 4 facts, including at least one of H2, H5 or H6$a$,
   '5', $a$7-8 facts, including H6 (the real problem) and H7 (sign-off)$a$),
 false),

-- SWE: exec scenario, "Lerato asks for something unreasonable" (docs/07 live defence item 3; doc 09 §4 E1, E5, E7, E8)
('software-engineer', 'exec_scenario', 'swe_exec_whatsapp', 1,
 $t$Lerato: "Can we just WhatsApp everyone on the base tomorrow?" Respond as you would to her.$t$,
 array[$p$What is your first sentence?$p$,
       $p$What can she have tomorrow, and what can't she?$p$,
       $p$What do you need from her to get there?$p$],
 jsonb_build_object(
   '1', $a$Says yes, or says no in jargon with no alternative$a$,
   '3', $a$Explains the risk understandably, but no options or clear ask$a$,
   '5', $a$Answer first; explains consent, contactability and the sender risk in business terms; offers what she can have now and the path to the rest; a specific ask with next steps$a$),
 false),
('software-engineer', 'exec_scenario', 'swe_exec_export', 2,
 $t$Lerato: "Add a button so I can download every customer, with their phone numbers, to my laptop for the weekend."$t$,
 array[$p$What is the real need behind the request?$p$,
       $p$How do you say no without stopping her work?$p$,
       $p$What would you restrict or log?$p$],
 jsonb_build_object(
   '1', $a$Builds it, or refuses flatly with no alternative$a$,
   '3', $a$Raises the data risk but offers no workable alternative$a$,
   '5', $a$Finds the need behind it, offers a minimal, logged alternative (a filtered view or a scoped export), and explains the POPIA risk in her terms$a$),
 false),
('software-engineer', 'exec_scenario', 'swe_exec_skip_tests', 3,
 $t$Lerato: "The CEO is watching. Skip the testing and go live today; we'll fix things later."$t$,
 array[$p$What does going live today cost compared with tomorrow, in her terms?$p$,
       $p$What would you be willing to cut?$p$,
       $p$How do you hold your position when she pushes back?$p$],
 jsonb_build_object(
   '1', $a$Caves, or gets defensive$a$,
   '3', $a$Holds the line, but only restates the risk$a$,
   '5', $a$Holds with evidence or offers a scoped go-live with a rollback plan; quantifies the risk; stays calm under push-back; gives her a clear decision$a$),
 false)
on conflict (role_slug, kind, key) do nothing;

-- ───────────────────────── Live reasoning pool ─────────────────────────
-- Same families and tiers as the online templates; the paper form is rendered from a seed.
insert into public.reasoning_items (family, tier, generator, form)
select f, t, f || '.v1', 'live'
from unnest(array['number_series', 'data_interp', 'deduction', 'letter_series', 'verbal', 'word_problem']) f
cross join unnest(array['easy', 'medium', 'hard']) t
on conflict (family, tier, form, version) do nothing;

-- ───────────────────────── Calibration runs ─────────────────────────
alter table public.calibration_runs
  add column if not exists rubric_id uuid references public.rubrics (id),
  add column if not exists gold_sample_ids uuid[] not null default '{}';
create index if not exists calibration_runs_rubric_idx on public.calibration_runs (rubric_key, ran_at desc);
create index if not exists gold_samples_rubric_idx on public.gold_samples (rubric_key, created_at);

-- ───────────────────────── Scorecard guards ─────────────────────────
-- NOT VALID: enforced for new and updated rows; existing rows are not re-checked.
alter table public.live_scorecards drop constraint if exists live_scorecards_submitted_total;
alter table public.live_scorecards add constraint live_scorecards_submitted_total
  check (submitted_at is null or total is not null) not valid;
alter table public.live_scorecards drop constraint if exists live_scorecards_retest_raw;
alter table public.live_scorecards add constraint live_scorecards_retest_raw
  check (case
           when kind = 'reasoning_retest' and submitted_at is not null then
             case when jsonb_typeof(scores -> 'raw') = 'number'
                  then (scores ->> 'raw')::numeric between 0 and 12 and (scores ->> 'raw')::numeric = trunc((scores ->> 'raw')::numeric)
                  else false end
           else true
         end) not valid;
