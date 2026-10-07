import { describe, expect, it } from "vitest";
import { assembleQuiz, QuizBankError, shuffleOptions, type BankItem } from "@/lib/quiz/assemble";
import { BLUEPRINT, QUIZ_ITEM_COUNT, QUIZ_ROLES, topicsFor } from "@/lib/quiz/blueprint";
import { createRng } from "@/lib/reasoning/rng";
import { syntheticBank } from "./helpers";

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);

describe("BLUEPRINT", () => {
  it("has 15 items per role in the doc 05 proportions", () => {
    expect(BLUEPRINT["software-engineer"].map((b) => b.count)).toEqual([3, 3, 2, 2, 2, 2, 1]);
    expect(BLUEPRINT["business-analyst"].map((b) => b.count)).toEqual([3, 4, 3, 2, 2, 1]);
    for (const role of QUIZ_ROLES) {
      expect(BLUEPRINT[role].reduce((n, b) => n + b.count, 0)).toBe(QUIZ_ITEM_COUNT);
    }
  });

  it("lists topics in doc order and nothing for unknown roles", () => {
    expect(topicsFor("software-engineer")).toEqual([
      "postgres_sql", "supabase_security", "nextjs_vercel", "data_engineering", "web_security", "ai_integration", "ops",
    ]);
    expect(topicsFor("business-analyst")).toEqual([
      "elicitation", "data_literacy", "requirements", "process_metrics", "compliance", "ai_judgement",
    ]);
    expect(topicsFor("nope")).toEqual([]);
  });
});

describe("shuffleOptions", () => {
  it("keeps the key pointing at the same option text", () => {
    const options = ["a", "b", "c", "d", "e"];
    for (let s = 1; s < 200; s++) {
      const out = shuffleOptions(options, [1, 3], createRng(s));
      expect([...out.options].sort()).toEqual(options);
      expect(out.answerKey.map((k) => out.options[k])).toEqual(expect.arrayContaining(["b", "d"]));
      expect(out.answerKey).toHaveLength(2);
      expect(out.answerKey).toEqual([...out.answerKey].sort((a, b) => a - b));
    }
  });
});

describe.each(QUIZ_ROLES)("assembleQuiz (%s)", (role) => {
  const bank = syntheticBank(role);
  const byId = new Map(bank.map((i) => [i.id, i]));

  it("builds 15 positions with exact topic counts and no duplicate items", () => {
    for (const seed of SEEDS) {
      const quiz = assembleQuiz(seed, bank);
      expect(quiz).toHaveLength(15);
      expect(quiz.map((q) => q.position)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      for (const { topic, count } of BLUEPRINT[role]) {
        expect(quiz.filter((q) => q.topic === topic)).toHaveLength(count);
      }
      expect(new Set(quiz.map((q) => q.itemId)).size).toBe(15);
      expect(new Set(quiz.map((q) => q.stem)).size).toBe(15);
    }
  });

  it("is deterministic per seed, whatever order the bank rows arrive in", () => {
    const reversed = [...bank].reverse();
    const shuffled = createRng(99).shuffle(bank);
    for (const seed of SEEDS.slice(0, 10)) {
      const a = assembleQuiz(seed, bank);
      expect(assembleQuiz(seed, reversed)).toEqual(a);
      expect(assembleQuiz(seed, shuffled)).toEqual(a);
    }
    const distinct = new Set(SEEDS.map((s) => assembleQuiz(s, bank).map((q) => q.itemId).join(",")));
    expect(distinct.size).toBeGreaterThan(SEEDS.length * 0.9);
  });

  it("shuffles options but the key still marks the original correct options", () => {
    let moved = 0;
    for (const seed of SEEDS) {
      for (const q of assembleQuiz(seed, bank)) {
        const src = byId.get(q.itemId)!;
        expect([...q.options].sort()).toEqual([...src.options].sort());
        expect(q.answerKey.map((k) => q.options[k]).sort()).toEqual(src.answer_key.map((k) => src.options[k]).sort());
        expect(q.multi).toBe(src.multi);
        if (q.options.join("|") !== src.options.join("|")) moved++;
      }
    }
    expect(moved).toBeGreaterThan(SEEDS.length * 15 * 0.7);
  });

  it("mixes topics across positions rather than serving them in blocks", () => {
    const firstTopics = new Set(SEEDS.map((s) => assembleQuiz(s, bank)[0]!.topic));
    expect(firstTopics.size).toBeGreaterThan(3);
  });

  it("refuses a bank that is too thin for a topic", () => {
    const topic = BLUEPRINT[role][0]!.topic;
    const thin = bank.filter((i) => i.topic !== topic).concat(bank.filter((i) => i.topic === topic).slice(0, 1));
    expect(() => assembleQuiz(1, thin)).toThrow(QuizBankError);
  });

  it("never draws two items with the same stem", () => {
    const topic = BLUEPRINT[role][0]!.topic;
    const count = BLUEPRINT[role][0]!.count;
    // Only `count` distinct stems in the topic, each duplicated under a second id.
    const base = bank.filter((i) => i.topic === topic).slice(0, count);
    const dupes: BankItem[] = base.map((i) => ({ ...i, id: `${i.id}-copy` }));
    const custom = bank.filter((i) => i.topic !== topic).concat(base, dupes);
    for (const seed of SEEDS) {
      const stems = assembleQuiz(seed, custom).filter((q) => q.topic === topic).map((q) => q.stem);
      expect(new Set(stems).size).toBe(count);
    }
  });
});

describe("assembleQuiz input checks", () => {
  it("rejects mixed or unknown roles", () => {
    const mixed = [...syntheticBank("software-engineer"), ...syntheticBank("business-analyst")];
    expect(() => assembleQuiz(1, mixed)).toThrow(QuizBankError);
    expect(() => assembleQuiz(1, syntheticBank("software-engineer").map((i) => ({ ...i, role_slug: "x" })))).toThrow(QuizBankError);
  });

  it("rejects malformed items it draws", () => {
    const bank = syntheticBank("business-analyst", 4).map((i) => ({ ...i, answer_key: [7], multi: false }));
    expect(() => assembleQuiz(1, bank)).toThrow(/out of range/);
  });
});
