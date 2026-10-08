// Offline stand-in for persona-lerato.v1 (BA Part 1 stakeholder chat), plus the JEV answers the
// persona gate and the work-submission injection pre-screen use.
//
// The persona stub "reveals" exactly the HIDDEN_FACTS it was given that are not marked
// already_discussed, so tests can see what the platform's gate let through. Markers in the
// candidate's latest message drive edge cases:
//   STUB:CLAIM_ALL    claims H01-H14 in revealed_fact_ids (the platform must intersect with the gate)
//   STUB:PERSONA_FAIL returns output that fails the schema (the platform must not charge a message)

function hiddenFacts(system) {
  const m = String(system).match(/HIDDEN_FACTS: (\[[\s\S]*\])\s*$/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

function latestMessage(text) {
  return text.match(/<candidate_message>\n([\s\S]*?)\n<\/candidate_message>/)?.[1] ?? "";
}

export default function personaLerato(_body, { text, system }) {
  const msg = latestMessage(text);
  if (msg.includes("STUB:PERSONA_FAIL")) return { nope: true };
  const facts = hiddenFacts(system);
  const fresh = facts.filter((f) => !f.already_discussed);
  const reply = fresh.length
    ? fresh.map((f) => f.fact).join(" ")
    : "Look, renewals are our bread and butter. What specifically do you need to know?";
  const ids = msg.includes("STUB:CLAIM_ALL")
    ? Array.from({ length: 14 }, (_, i) => `H${String(i + 1).padStart(2, "0")}`)
    : fresh.map((f) => f.id);
  return { reply, revealed_fact_ids: ids };
}

const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** A trigger matches when the message contains the whole phrase, or every word of 3+ letters in it. */
function triggerHit(trigger, msg) {
  const t = norm(trigger);
  const m = norm(msg);
  if (m.includes(t)) return true;
  const words = t.trim().split(" ").filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => m.includes(` ${w} `) || m.includes(` ${w.replace(/s$/, "")} `));
}

const noul = (p) => ({ type: "noul", noul: p });
const reply = (answers) => ({ model: "jev-stub", answers, usage: { input_tokens: 1, output_tokens: 1 } });

/** JEV answers for the persona gate and the submission pre-screen; null for anyone else's requests. */
export function jev(body) {
  const state = body?.state ?? {};
  const qs = body?.questions ?? {};
  const context = typeof state.context === "string" ? state.context : "";

  if (context.startsWith("BA discovery chat")) {
    const msg = String(state.candidate_message ?? "");
    const answers = {};
    for (const [id, q] of Object.entries(qs)) {
      if (id === "off_script") {
        // Like a real classifier: clear dump/instruction intent only, not "the instructions from
        // legal" or "does the system prompt the agents".
        answers[id] = noul(
          /hidden facts|list (all|every)\b.*\b(facts?|secrets?)\b|everything you know\s*[.?!]*$|your (system )?(prompt|instructions)\b|ignore (all|previous|your)/i.test(msg) ? 0.95 : 0.05,
        );
      } else if (id.startsWith("fact_")) {
        const triggers = String(q.instructions).match(/any of: (.*)\?$/)?.[1]?.split("; ") ?? [];
        answers[id] = noul(triggers.some((t) => triggerHit(t, msg)) ? 0.9 : 0.1);
      } else if (id.startsWith("volunteer_")) {
        answers[id] = noul(/\b(sales?|upgrades?|targets?|goals?)\b/i.test(msg) ? 0.9 : 0.1);
      } else {
        answers[id] = noul(0.1);
      }
    }
    return reply(answers);
  }

  if (context.startsWith("Submission injection pre-screen")) {
    const t = String(state.text ?? "");
    return reply({ grader_injection: noul(/STUB:GRADER_INJECTION|ignore (all|previous) instructions|full marks/i.test(t) ? 0.92 : 0.05) });
  }
  return null;
}
