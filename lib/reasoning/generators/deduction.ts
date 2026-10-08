import type { Generator, Tier } from '../types';
import { createRng, deriveSeed, type Rng } from '../rng';
import { buildOptions } from '../options';
import { NAMES, ORDINALS } from '../format';

/** Ordering clues. Positions are 1..5 (1 = first). */
export type Clue =
  | { type: 'before'; a: string; b: string } // a came (some time) before b
  | { type: 'immediately_after'; a: string; b: string } // pos(a) = pos(b) + 1
  | { type: 'two_after'; a: string; b: string } // pos(a) = pos(b) + 2
  | { type: 'not_end'; a: string } // a was neither first nor last
  | { type: 'position'; a: string; pos: number }; // a was at pos (easy tier only)

export type ClueType = Clue['type'];

/** Does `clue` hold for `order` (order[0] is first)? */
export function clueHolds(clue: Clue, order: readonly string[]): boolean {
  const p = (name: string) => order.indexOf(name) + 1;
  switch (clue.type) {
    case 'before':
      return p(clue.a) < p(clue.b);
    case 'immediately_after':
      return p(clue.a) === p(clue.b) + 1;
    case 'two_after':
      return p(clue.a) === p(clue.b) + 2;
    case 'not_end':
      return p(clue.a) !== 1 && p(clue.a) !== order.length;
    case 'position':
      return p(clue.a) === clue.pos;
  }
}

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((x, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

/** Brute force: every ordering of `names` consistent with all clues. */
export function solveOrders(names: readonly string[], clues: readonly Clue[]): string[][] {
  return permutations(names).filter((order) => clues.every((c) => clueHolds(c, order)));
}

/** The distinct people who could be at `position` (1-based) given the clues. */
export function possibleAt(names: readonly string[], clues: readonly Clue[], position: number): string[] {
  return [...new Set(solveOrders(names, clues).map((o) => o[position - 1] as string))];
}

interface TierRules {
  minClues: number;
  maxClues: number;
  /** Weighted clue-type pool. */
  types: ClueType[];
  askable: number[];
}

export const DEDUCTION_RULES: Record<Tier, TierRules> = {
  easy: { minClues: 2, maxClues: 3, types: ['position', 'before', 'immediately_after', 'immediately_after'], askable: [1, 2, 3, 4, 5] },
  medium: { minClues: 3, maxClues: 4, types: ['before', 'before', 'immediately_after', 'two_after', 'not_end'], askable: [1, 2, 3, 4, 5] },
  hard: { minClues: 4, maxClues: 5, types: ['before', 'before', 'before', 'immediately_after', 'two_after', 'not_end'], askable: [2, 3, 4] },
};

const CONTEXTS = [
  { intro: 'Five colleagues each gave a short talk at a team meeting, one after another.', verb: 'spoke' },
  { intro: 'Five runners finished a fun run, one after another, with no ties.', verb: 'finished' },
  { intro: 'Five clients were served at a branch counter, one at a time.', verb: 'was served' },
] as const;

/** A random clue that is true for `order` (positions are 0-based internally). */
function randomTrueClue(rng: Rng, order: string[], type: ClueType, askedPos: number): Clue | null {
  const n = order.length;
  const name = (i: number) => order[i] as string;
  switch (type) {
    case 'before': {
      const i = rng.int(0, n - 2);
      const j = rng.int(i + 1, n - 1);
      return { type, a: name(i), b: name(j) };
    }
    case 'immediately_after': {
      const i = rng.int(1, n - 1);
      return { type, a: name(i), b: name(i - 1) };
    }
    case 'two_after': {
      const i = rng.int(2, n - 1);
      return { type, a: name(i), b: name(i - 2) };
    }
    case 'not_end':
      return { type, a: name(rng.int(1, n - 2)) };
    case 'position': {
      // Never state the asked position outright.
      const i = rng.pick([0, 1, 2, 3, 4].filter((x) => x !== askedPos - 1));
      return { type, a: name(i), pos: i + 1 };
    }
  }
}

const sameClue = (x: Clue, y: Clue) => JSON.stringify(x) === JSON.stringify(y);

interface Puzzle {
  names: string[]; // alphabetical, as presented
  order: string[];
  clues: Clue[];
  askedPosition: number;
}

function tryBuild(rng: Rng, tier: Tier): Puzzle | null {
  const rules = DEDUCTION_RULES[tier];
  const order = rng.shuffle(NAMES).slice(0, 5);
  const names = [...order].sort();
  const askedPosition = rng.pick(rules.askable);
  const clues: Clue[] = [];
  const allOrders = permutations(names);
  let candidates = allOrders;
  let positionClues = 0;

  for (let samples = 0; samples < 60 && clues.length < rules.maxClues; samples++) {
    const type = rng.pick(rules.types);
    if (type === 'position' && positionClues >= 1) continue;
    const clue = randomTrueClue(rng, order, type, askedPosition);
    if (!clue || clues.some((c) => sameClue(c, clue))) continue;
    const narrowed = candidates.filter((o) => clueHolds(clue, o));
    if (narrowed.length === candidates.length) continue; // adds no information
    clues.push(clue);
    if (type === 'position') positionClues++;
    candidates = narrowed;
    if (isUnique(candidates, askedPosition)) {
      const needed = pruneRedundant(allOrders, clues, askedPosition);
      return needed.length >= rules.minClues ? { names, order, clues: needed, askedPosition } : null;
    }
  }
  return null;
}

const isUnique = (orders: string[][], position: number) => new Set(orders.map((o) => o[position - 1])).size === 1;

/** Drop any clue the answer does not depend on, so every clue shown is needed. */
function pruneRedundant(allOrders: string[][], clues: Clue[], position: number): Clue[] {
  let kept = clues;
  for (const c of clues) {
    const without = kept.filter((k) => k !== c);
    if (isUnique(allOrders.filter((o) => without.every((k) => clueHolds(k, o))), position)) kept = without;
  }
  return kept;
}

function renderClue(rng: Rng, clue: Clue, verb: string): string {
  switch (clue.type) {
    case 'before':
      return rng.next() < 0.5 ? `${clue.a} ${verb} before ${clue.b}.` : `${clue.b} ${verb} after ${clue.a}.`;
    case 'immediately_after':
      return `${clue.a} ${verb} immediately after ${clue.b}.`;
    case 'two_after':
      return `${clue.a} ${verb} exactly two places after ${clue.b}.`;
    case 'not_end':
      return `${clue.a} was neither first nor last.`;
    case 'position':
      return `${clue.a} was ${ORDINALS[clue.pos - 1]}.`;
  }
}

const MAX_ATTEMPTS = 2000;

export const deduction: Generator = (seed, tier) => {
  let puzzle: Puzzle | null = null;
  let attempt = 0;
  let rng = createRng(seed);
  for (; attempt < MAX_ATTEMPTS && !puzzle; attempt++) {
    rng = createRng(attempt === 0 ? seed : deriveSeed(seed, attempt));
    puzzle = tryBuild(rng, tier);
  }
  if (!puzzle) throw new Error(`deduction: no puzzle found for seed ${seed} (${tier})`);

  const ctx = rng.pick(CONTEXTS);
  const list = `${puzzle.names.slice(0, 4).join(', ')} and ${puzzle.names[4]}`;
  const lines = puzzle.clues.map((c) => `- ${renderClue(rng, c, ctx.verb)}`);
  const answer = puzzle.order[puzzle.askedPosition - 1] as string;
  const { options, answerIndex } = buildOptions(
    rng,
    answer,
    puzzle.names.filter((n) => n !== answer),
    () => answer, // never needed: there are always 4 other names
  );
  return {
    family: 'deduction',
    tier,
    stem: {
      prompt: `${ctx.intro} They were ${list}.\n${lines.join('\n')}\nWho ${ctx.verb} ${ORDINALS[puzzle.askedPosition - 1]}?`,
      footnote: '"Before" and "after" do not mean "immediately" unless the clue says so.',
    },
    options,
    answerIndex,
    meta: { ...puzzle, attempts: attempt },
  };
};
