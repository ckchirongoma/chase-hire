import type { Generator, Tier } from '../types';
import { createRng, type Rng } from '../rng';
import { buildOptions } from '../options';

export type LetterRule = 'constant' | 'increasing' | 'interleaved' | 'pairs_opposite' | 'interleaved_wrap';

/** Alphabet position (0 = A) to letter, wrapping around in both directions. */
export const letter = (i: number): string => String.fromCharCode(65 + (((i % 26) + 26) % 26));

interface LetterSeries {
  rule: LetterRule;
  terms: string[];
  answer: string;
  distractors: string[];
  params: Record<string, number>;
}

// ---------- easy ----------

function constant(rng: Rng): LetterSeries {
  const step = rng.pick([2, 3, 4, 5, 6, -2, -3, -4]);
  const start = rng.int(0, 25);
  const pos = Array.from({ length: 5 }, (_, i) => start + i * step);
  const l = pos[4] as number;
  return {
    rule: 'constant',
    terms: pos.map(letter),
    answer: letter(l + step),
    distractors: [l + step + 1, l + step - 1, l + 2 * step, l - step, l + step + 2].map(letter),
    params: { start, step },
  };
}

// ---------- medium ----------

function increasing(rng: Rng): LetterSeries {
  const s0 = rng.int(1, 3);
  const pos = [rng.int(0, 25)];
  for (let i = 0; i < 4; i++) pos.push((pos[i] as number) + s0 + i);
  const l = pos[4] as number;
  const nextStep = s0 + 4;
  return {
    rule: 'increasing',
    terms: pos.map(letter),
    answer: letter(l + nextStep),
    distractors: [
      l + nextStep - 1, // repeated the last step
      l + nextStep + 1,
      l + nextStep + 2,
      l + 2 * nextStep,
    ].map(letter),
    params: { s0 },
  };
}

function interleaved(rng: Rng): LetterSeries {
  const sa = rng.int(1, 3);
  const sb = rng.pick([-2, -1, 2, 3, 4].filter((s) => s !== sa));
  const a = rng.int(0, 25);
  const b = a + rng.int(6, 20); // keep the two series visibly apart
  const terms: string[] = [];
  for (let i = 0; i < 3; i++) terms.push(letter(a + i * sa), letter(b + i * sb));
  const lastA = a + 2 * sa;
  const lastB = b + 2 * sb;
  return {
    rule: 'interleaved',
    terms,
    answer: letter(lastA + sa),
    distractors: [
      letter(lastB + sb), // continued the wrong series
      letter(lastB + sa), // continued from the last letter shown
      letter(lastA + sb), // right series, wrong step
      letter(lastA + sa + 1),
      letter(lastA + sa - 1),
    ],
    params: { a, sa, b, sb },
  };
}

// ---------- hard ----------

function pairsOpposite(rng: Rng): LetterSeries {
  const s1 = rng.int(1, 4);
  const s2 = rng.int(1, 4);
  const f = rng.int(0, 25);
  const s = rng.int(0, 25);
  const pair = (x: number, y: number) => letter(x) + letter(y);
  const terms = Array.from({ length: 4 }, (_, i) => pair(f + i * s1, s - i * s2));
  const nf = f + 4 * s1;
  const ns = s - 4 * s2;
  const lf = f + 3 * s1;
  const ls = s - 3 * s2;
  return {
    rule: 'pairs_opposite',
    terms,
    answer: pair(nf, ns),
    distractors: [
      pair(nf, ls + s2), // second letter moved forward instead of back
      pair(lf + s2, ls - s1), // swapped the two steps
      pair(nf + 1, ns), // first letter off by one
      pair(nf, ns + 1), // second letter off by one
      pair(nf, ns - 1),
      pair(nf + s1, ns - s2), // skipped a step
    ],
    params: { f, s1, s, s2 },
  };
}

function interleavedWrap(rng: Rng): LetterSeries {
  const sa = rng.int(3, 6);
  const sb = rng.pick([-5, -4, -3, -2]);
  const a = rng.int(26 - 3 * sa, 25); // forces series A past Z
  const b = a + rng.int(6, 20);
  const terms: string[] = [];
  for (let i = 0; i < 4; i++) {
    terms.push(letter(a + i * sa));
    if (i < 3) terms.push(letter(b + i * sb));
  }
  // 7 shown (A B A B A B A); the next letter belongs to series B.
  const lastA = a + 3 * sa;
  const lastB = b + 2 * sb;
  return {
    rule: 'interleaved_wrap',
    terms,
    answer: letter(lastB + sb),
    distractors: [
      letter(lastA + sa), // continued the wrong series
      letter(lastB - sb), // went the wrong direction
      letter(lastB + sb + 1),
      letter(lastB + sb - 1),
      letter(lastA + sb), // applied B's step to the last letter shown
    ],
    params: { a, sa, b, sb },
  };
}

const BY_TIER: Record<Tier, ((rng: Rng) => LetterSeries)[]> = {
  easy: [constant],
  medium: [increasing, interleaved],
  hard: [pairsOpposite, interleavedWrap],
};

export const letterSeries: Generator = (seed, tier) => {
  const rng = createRng(seed);
  const s = rng.pick(BY_TIER[tier])(rng);
  const isPair = s.answer.length === 2;
  const { options, answerIndex } = buildOptions(rng, s.answer, s.distractors, () =>
    isPair ? letter(rng.int(0, 25)) + letter(rng.int(0, 25)) : letter(rng.int(0, 25)),
  );
  return {
    family: 'letter_series',
    tier,
    stem: { prompt: `What comes next?\n${s.terms.join(', ')}, ?` },
    options,
    answerIndex,
    meta: { rule: s.rule, terms: s.terms, answer: s.answer, params: s.params },
  };
};
