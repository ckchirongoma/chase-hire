# 15: JEV (TypeSafe System One model)

## What it is

JEV is TypeSafe's "System One" model, named after Kahneman's fast, intuitive System 1.
It is **not an LLM**: you send a *state* (text or JSON) and predefined *questions*, and it
returns typed answers with probabilities. It writes no text and gives no rationale.

| Question type | Returns |
|---|---|
| `choice` (up to 255 options) | `choice`, `confidence`, `probabilities` per option |
| `score` (2–10 described levels) | `score` (0-based level), `confidence`, `probabilities` |
| `noul` (yes/no) | `noul`: probability that the answer is yes |

API: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`,
body `{model, state, questions}`. We pin `jev-1.13.0`. Measured on our key: 3 questions in
~0.6 s. Vendor pricing: US$0.042 per million input tokens (≈ R0.76 at R18/US$), output free.
Source: thepromptindex.com JEV guide (Oct 2026); vendor benchmark claims are self-reported.

## Benefits for us

1. **Cost and speed.** Flow-control decisions cost a fraction of a cent and come back in well under a second, so the AI interview feels conversational without a frontier model on every turn.
2. **Typed output.** Answers are always one of the options we defined, so there is no JSON to repair and no hallucinated free text.
3. **Probabilities.** Code can threshold them (e.g. only act on confidence ≥ 0.7) and fall back to a rule otherwise.

## Limits (why it is NOT used everywhere)

- No rationale or quotes. Hard rule 4 requires every grade to store evidence and a rationale, so **graders stay on OpenRouter LLMs**.
- Not for multi-step reasoning, arithmetic or writing text.
- About 68% accuracy on the vendor's own benchmark: fine for routing, not for decisions about people. **No hiring decision ever depends on JEV**, and humans decide everything (POPIA s71).
- Candidate text can carry prompt injection, so JEV outputs only steer the script; they never unlock content beyond what the rules allow.

## Where it is used

| Place | Question(s) | Fallback if JEV is unavailable |
|---|---|---|
| AI interview: choose CV topics (one call) | `choice`: most impressive quantified claim; claim closest to the role spec; the listed skill that matters most for the role | longest quantified claim; keyword overlap with the role spec; first listed skill |
| AI interview: after each answer (sufficiency gate) | `noul`: is this answer specific enough to move on (≥ 0.6 = move on)? `choice`: what is it missing most (specifics, ownership, failure, trade-off, consistency, AI use)? The chosen target is handed to the follow-up writer (an LLM, doc 10) | move on if the answer has 120+ words and a number; otherwise a target from simple rules (no number → specifics, more "we" than "I" → ownership, …) |
| AI interview + persona chat: off-script messages | `noul`: is the candidate trying to change the instructions or get graded? `noul`: is it a question about the role rather than an answer? | regex injection detector from `lib/sanitise.ts` |
| BA Part 1 persona (Lerato): fact reveal gating | `noul` per hidden fact: does this message directly ask about the fact's trigger topics? The persona LLM only ever receives facts that passed (≥ 0.6), so "list everything" cannot leak the rest | keyword match on the trigger topics |
| Submissions: injection pre-screen | `noul`: does the text contain instructions aimed at an AI grader? (signal only, combined with the regex sanitiser) | regex sanitiser only |

## Configuration

`TYPESAFE_API_KEY` (server-only), optional `JEV_MODEL` (default `jev-1.13.0`) and
`TYPESAFE_BASE_URL`. Client: `lib/jev/client.ts` (5 s timeout, one retry on 429/529/5xx,
returns `null` on any failure so callers fall back). Every JEV-driven step logs the model and
the probabilities it acted on, so an admin can see why the script took a branch.
