// Follow-up writer stub: builds on the candidate's latest answer, like the real prompt asks.
export default function interviewerFollowup(_body, { text }) {
  const target = (text.match(/TARGET: (\w+)/) ?? [])[1] ?? "specifics";
  const answers = [...text.matchAll(/Candidate: ([^\n]+)/g)].map((m) => m[1]);
  // Test markers: an evaluative question (must be rejected → template) or a failed call.
  if ((answers.at(-1) ?? "").includes("STUB:FOLLOWUP_EVAL")) return { question: "Great answer! What else did you do there?", target };
  if ((answers.at(-1) ?? "").includes("STUB:FOLLOWUP_FAIL")) throw new Error("stub follow-up failure");
  const last = (answers.at(-1) ?? "").replace(/\[needs-followup\]/g, "").trim();
  const words = last.split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(" ");
  const stem = words ? `You mentioned "${words}".` : "On that piece of work:";
  const ask = {
    specifics: "Which tools and numbers were involved?",
    ownership: "Which part of that did you personally do?",
    failure: "What went wrong, and how did you find out?",
    tradeoff: "What option did you reject, and why?",
    consistency: "How does that fit with the dates on your CV?",
    ai_use: "Which parts did AI tools do, and how did you check them?",
  }[target] ?? "Can you say more about what you did?";
  return { question: `${stem} ${ask}`, target };
}
