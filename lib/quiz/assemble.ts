import { createRng, deriveSeed, type Rng } from "@/lib/reasoning/rng";
import { BLUEPRINT, isQuizRole, type BlueprintEntry } from "./blueprint";

/** A quiz_items row as read from the bank. answer_key holds 0-based indexes into options. */
export type BankItem = {
  id: string;
  role_slug: string;
  topic: string;
  stem: string;
  options: string[];
  answer_key: number[];
  multi: boolean;
};

/** One position in an attempt, with options shuffled and the key remapped. Server-side only. */
export type AssembledQuizItem = {
  position: number;
  itemId: string;
  topic: string;
  stem: string;
  options: string[];
  multi: boolean;
  answerKey: number[];
};

export class QuizBankError extends Error {}

/** Shuffles options and remaps the answer key so it still points at the same option text. */
export function shuffleOptions(
  options: readonly string[],
  answerKey: readonly number[],
  rng: Rng,
): { options: string[]; answerKey: number[] } {
  const perm = rng.shuffle(options.map((_, i) => i));
  return {
    options: perm.map((i) => options[i] as string),
    answerKey: answerKey.map((k) => perm.indexOf(k)).sort((a, b) => a - b),
  };
}

function checkItem(item: BankItem) {
  const n = item.options.length;
  const keys = new Set(item.answer_key);
  if (n < 4 || n > 5) throw new QuizBankError(`Item ${item.id} needs 4-5 options`);
  if (keys.size === 0 || keys.size !== item.answer_key.length) throw new QuizBankError(`Item ${item.id} has a bad answer key`);
  if (item.answer_key.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) {
    throw new QuizBankError(`Item ${item.id} has an answer index out of range`);
  }
  if (!item.multi && keys.size !== 1) throw new QuizBankError(`Item ${item.id} is single-answer but has ${keys.size} keys`);
}

/**
 * Builds one attempt: for each blueprint topic, draws the required number of distinct
 * items at random (seeded), mixes the topics across positions 1..N, and shuffles each
 * item's options with the key remapped. The same seed and bank always give the same quiz,
 * whatever order the bank rows arrive in.
 */
export function assembleQuiz(seed: number, items: readonly BankItem[], blueprint?: readonly BlueprintEntry[]): AssembledQuizItem[] {
  let plan = blueprint;
  if (!plan) {
    const roles = new Set(items.map((i) => i.role_slug));
    const [role] = [...roles];
    if (roles.size !== 1 || !role || !isQuizRole(role)) throw new QuizBankError("Items must all belong to one quiz role");
    plan = BLUEPRINT[role];
  }

  // Sort by id (then dedupe) so selection never depends on the order the DB returned rows in.
  const byId = new Map<string, BankItem>();
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const bank = [...byId.values()];

  const rng = createRng(seed);
  const seenStems = new Set<string>();
  const chosen: BankItem[] = [];
  for (const { topic, count } of plan) {
    const pool = rng.shuffle(bank.filter((i) => i.topic === topic));
    let taken = 0;
    for (const item of pool) {
      if (taken === count) break;
      const stemKey = item.stem.trim().toLowerCase();
      if (seenStems.has(stemKey)) continue;
      checkItem(item);
      seenStems.add(stemKey);
      chosen.push(item);
      taken++;
    }
    if (taken < count) {
      throw new QuizBankError(`Not enough active items for ${topic}: need ${count}, have ${taken}`);
    }
  }

  return rng.shuffle(chosen).map((item, i) => {
    const position = i + 1;
    const shuffled = shuffleOptions(item.options, item.answer_key, createRng(deriveSeed(seed, position)));
    return {
      position,
      itemId: item.id,
      topic: item.topic,
      stem: item.stem,
      options: shuffled.options,
      multi: item.multi,
      answerKey: shuffled.answerKey,
    };
  });
}
