import type { Generator, Tier } from '../types';
import { createRng, type Rng } from '../rng';
import { buildOptions } from '../options';

export type NumberRule =
  | 'arithmetic'
  | 'geometric'
  | 'second_order'
  | 'interleaved'
  | 'alternating_ops'
  | 'diff_squares'
  | 'diff_cubes'
  | 'diff_geometric'
  | 'fibonacci_plus';

interface Series {
  rule: NumberRule;
  terms: number[]; // shown terms
  answer: number;
  distractors: number[]; // in priority order (common error patterns first)
  params: Record<string, number | string>;
}

const last = (a: number[]) => a[a.length - 1] as number;
const at = (a: number[], i: number) => a[i < 0 ? a.length + i : i] as number;

function build(rule: NumberRule, terms: number[], next: number, distractors: number[], params: Series['params']): Series {
  return { rule, terms, answer: next, distractors, params };
}

// ---------- easy ----------

function arithmetic(rng: Rng): Series {
  const descending = rng.next() < 0.3;
  const step = rng.int(3, 12) * (descending ? -1 : 1);
  const start = descending ? rng.int(70, 150) : rng.int(2, 40);
  const terms = Array.from({ length: 5 }, (_, i) => start + i * step);
  const ans = last(terms) + step;
  return build('arithmetic', terms, ans, [ans + step, ans + 1, ans - 1, ans + 2, ans - 2], { start, step });
}

function geometric(rng: Rng): Series {
  const ratio = rng.pick([2, 3]);
  const base = ratio === 2 ? rng.int(1, 15) : rng.int(1, 7);
  const up = Array.from({ length: 6 }, (_, i) => base * ratio ** i);
  if (rng.next() < 0.3) {
    // Dividing series, e.g. 480, 240, 120, 60, 30 -> 15
    const terms = up.slice(1).reverse();
    const l = last(terms);
    const ans = base;
    const ds = [ans + ratio, ans + 1, ans - 1, l - ratio, l - (at(terms, -2) - l), ans * ratio + 1];
    return build('geometric', terms, ans, ds.filter((d) => d > 0), { start: terms[0] as number, ratio: 1 / ratio });
  }
  const terms = up.slice(0, 5);
  const l = last(terms);
  const ans = l * ratio;
  const linear = l + (l - at(terms, -2));
  return build('geometric', terms, ans, [linear, l * (ratio + 1), ans + ratio, ans - ratio, ans + l], { start: base, ratio });
}

// ---------- medium ----------

function secondOrder(rng: Rng): Series {
  const start = rng.int(2, 30);
  const d0 = rng.int(1, 6);
  const dd = rng.int(2, 5);
  const terms = [start];
  for (let i = 0; i < 5; i++) terms.push(last(terms) + d0 + i * dd);
  const lastDiff = d0 + 4 * dd;
  const ans = last(terms) + lastDiff + dd;
  return build('second_order', terms, ans, [
    last(terms) + lastDiff, // linear: repeated the last difference
    ans + dd, // skipped a step
    ans + 1,
    ans - 1,
    last(terms) + lastDiff + 2 * dd + 1,
  ], { start, d0, dd });
}

function interleaved(rng: Rng): Series {
  const a1 = rng.int(2, 15);
  const s1 = rng.int(2, 6);
  const b1 = rng.int(30, 60);
  const s2 = rng.pick([-5, -4, -3, -2, 7, 8, 9]);
  const terms: number[] = [];
  for (let i = 0; i < 3; i++) terms.push(a1 + i * s1, b1 + i * s2);
  const ans = a1 + 3 * s1; // next term belongs to the first series
  return build('interleaved', terms, ans, [
    b1 + 3 * s2, // continued the wrong series
    last(terms) + (last(terms) - at(terms, -2)), // treated it as one linear series
    ans + s1,
    at(terms, -2) + s2, // right series, wrong step
    ans + 1,
    ans - 1,
  ], { a1, s1, b1, s2 });
}

function alternatingOps(rng: Rng): Series {
  const add = rng.int(1, 6);
  const mul = rng.pick([2, 3]);
  const firstOp = rng.pick(['add', 'mul'] as const);
  const opAt = (i: number) => ((i % 2 === 0) === (firstOp === 'add') ? 'add' : 'mul');
  const apply = (x: number, op: 'add' | 'mul') => (op === 'add' ? x + add : x * mul);
  const terms = [rng.int(1, 9)];
  for (let i = 0; i < 5; i++) terms.push(apply(last(terms), opAt(i)));
  const nextOp = opAt(5);
  const ans = apply(last(terms), nextOp);
  const otherOp = nextOp === 'add' ? 'mul' : 'add';
  return build('alternating_ops', terms, ans, [
    apply(last(terms), otherOp), // wrong operation
    apply(ans, otherOp), // applied both operations
    last(terms) + (last(terms) - at(terms, -2)), // linear extrapolation
    ans + 1,
    ans - 1,
    ans + add,
  ], { add, mul, firstOp });
}

// ---------- hard ----------

function diffPowers(rng: Rng, power: 2 | 3): Series {
  const k0 = power === 2 ? rng.int(1, 4) : rng.int(1, 2);
  const terms = [rng.int(1, 60)];
  for (let i = 0; i < 4; i++) terms.push(last(terms) + (k0 + i) ** power);
  const lastDiff = (k0 + 3) ** power;
  const prevDiff = (k0 + 2) ** power;
  const ans = last(terms) + (k0 + 4) ** power;
  return build(power === 2 ? 'diff_squares' : 'diff_cubes', terms, ans, [
    last(terms) + lastDiff + (lastDiff - prevDiff), // assumed constant second difference
    last(terms) + lastDiff, // repeated the last difference
    last(terms) + (k0 + 5) ** power, // skipped a power
    ans + 1,
    ans - 1,
    last(terms) + 2 * lastDiff,
  ], { k0, power });
}

function diffGeometric(rng: Rng): Series {
  const d0 = rng.int(1, 4);
  const r = rng.pick([2, 3]);
  const terms = [rng.int(1, 60)];
  for (let i = 0; i < 4; i++) terms.push(last(terms) + d0 * r ** i);
  const lastDiff = d0 * r ** 3;
  const prevDiff = d0 * r ** 2;
  const ans = last(terms) + lastDiff * r;
  return build('diff_geometric', terms, ans, [
    last(terms) + lastDiff + (lastDiff - prevDiff), // assumed arithmetic differences
    last(terms) + lastDiff, // repeated the last difference
    last(terms) * r, // multiplied the term instead of the difference
    ans + 1,
    ans - 1,
  ], { d0, r });
}

function fibonacciPlus(rng: Rng): Series {
  const k = rng.int(1, 3);
  const terms = [rng.int(1, 6), rng.int(2, 9)];
  while (terms.length < 6) terms.push(last(terms) + at(terms, -2) + k);
  const ans = last(terms) + at(terms, -2) + k;
  return build('fibonacci_plus', terms, ans, [
    last(terms) + at(terms, -2), // forgot the +k
    last(terms) + (last(terms) - at(terms, -2)), // linear extrapolation
    ans + 1,
    last(terms) + at(terms, -3) + k, // added the wrong earlier term
    2 * last(terms),
  ], { k });
}

const BY_TIER: Record<Tier, ((rng: Rng) => Series)[]> = {
  easy: [arithmetic, geometric],
  medium: [secondOrder, interleaved, alternatingOps],
  hard: [(r) => diffPowers(r, 2), (r) => diffPowers(r, 3), diffGeometric, fibonacciPlus],
};

export const numberSeries: Generator = (seed, tier) => {
  const rng = createRng(seed);
  const s = rng.pick(BY_TIER[tier])(rng);
  const nudges = [-6, -5, -4, -3, -2, 2, 3, 4, 5, 6];
  const { options, answerIndex } = buildOptions(
    rng,
    String(s.answer),
    s.distractors.map(String),
    () => String(s.answer + rng.pick(nudges) * rng.int(1, 3)),
  );
  return {
    family: 'number_series',
    tier,
    stem: { prompt: `What number comes next?\n${s.terms.join(', ')}, ?` },
    options,
    answerIndex,
    meta: { rule: s.rule, terms: s.terms, answer: s.answer, params: s.params },
  };
};
