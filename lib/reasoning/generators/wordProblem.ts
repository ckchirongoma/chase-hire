import type { Generator, Tier } from '../types';
import { createRng, type Rng } from '../rng';
import { buildOptions } from '../options';
import { commas, NAMES, rand } from '../format';

export type WordVariant = 'work_rate' | 'ratio' | 'pct_successive' | 'inverse_rate' | 'estimate';

interface Built {
  prompt: string;
  answer: string;
  distractors: string[];
  fallback: () => string;
  meta: Record<string, unknown>;
}

const hours = (h: number) => (h === 1 ? '1 hour' : `${h} hours`);
const TASKS = [
  { unit: 'support tickets', verb: 'clears' },
  { unit: 'invoices', verb: 'processes' },
  { unit: 'insurance claims', verb: 'assesses' },
  { unit: 'account applications', verb: 'reviews' },
];
const twoNames = (rng: Rng) => rng.shuffle(NAMES).slice(0, 2) as [string, string];

// ---------- easy: combined work rate ----------

function workRate(rng: Rng): Built {
  const [x, y] = twoNames(rng);
  const task = rng.pick(TASKS);
  const a = rng.int(6, 20);
  let b = rng.int(4, 15);
  if (b === a) b = a - 2;
  const h = rng.int(2, 8);
  const total = h * (a + b);
  const alone = [total / a, total / b].filter((v) => Number.isInteger(v));
  return {
    prompt: `${x} ${task.verb} ${a} ${task.unit} an hour and ${y} ${task.verb} ${b} an hour. Working together, how many hours will they take to finish ${total} ${task.unit}?`,
    answer: hours(h),
    distractors: [
      hours(2 * h), // used the average rate instead of the combined rate
      ...alone.map(hours), // only one person working
      hours(h + 1),
      hours(h - 1),
      hours(h + 2),
    ],
    fallback: () => hours(h + rng.int(3, 9)),
    meta: { variant: 'work_rate', a, b, total },
  };
}

// ---------- medium ----------

const RATIOS: [number, number][] = [[2, 3], [3, 5], [2, 5], [3, 4], [4, 5], [3, 7], [5, 7], [4, 7], [5, 8]];

function ratio(rng: Rng): Built {
  const [p, q] = rng.pick(RATIOS);
  const k = rng.int(10, 60);
  const diff = (q - p) * k;
  const total = (p + q) * k;
  const calls = (n: number) => `${commas(n)} calls`;
  return {
    prompt: `Calls are shared between Team A and Team B in the ratio ${p}:${q}. Team B handled ${diff} more calls than Team A. How many calls did the two teams handle in total?`,
    answer: calls(total),
    distractors: [
      calls(diff * (p + q)), // treated the difference as one ratio part
      calls(q * k), // gave Team B only
      calls(total + diff), // added the difference on top
      calls(p * k), // gave Team A only
      calls(diff * q),
    ],
    fallback: () => calls(total + rng.pick([-1, 1]) * k * rng.int(1, 3)),
    meta: { variant: 'ratio', p, q, diff },
  };
}

function pctSuccessive(rng: Rng): Built {
  const start = 400 * rng.int(5, 50);
  const up = rng.pick([10, 20, 25, 50]);
  const second = rng.pick([-10, -20, -25, -40, 10, 20]);
  // Integer arithmetic: up and second are multiples of 5 and start is a multiple of 400.
  const result = (start * (100 + up) * (100 + second)) / 10000;
  const verb2 = second < 0 ? `fell by ${-second}%` : `rose by a further ${second}%`;
  return {
    prompt: `A client's monthly bill was ${rand(start)}. It rose by ${up}%, and then the new amount ${verb2}. What is the bill now?`,
    answer: rand(result),
    distractors: [
      rand((start * (100 + up + second)) / 100), // added the percentages
      rand((start * (100 + up)) / 100), // applied only the first change
      rand((start * (100 + up) * (100 - second)) / 10000), // second change in the wrong direction
      rand(start), // assumed the changes cancel
      rand((start * (100 + second)) / 100), // applied only the second change
    ],
    fallback: () => rand(result + rng.pick([-1, 1]) * 100 * rng.int(1, 9)),
    meta: { variant: 'pct_successive', start, up, second },
  };
}

// ---------- hard ----------

/** [a, b, t]: a alone, b alone, together t; all whole hours. */
const INVERSE_TRIPLES: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let a = 3; a <= 40; a++) {
    for (let b = 3; b <= 40; b++) {
      if (a !== b && (a * b) % (a + b) === 0 && (a * b) / (a + b) >= 2) out.push([a, b, (a * b) / (a + b)]);
    }
  }
  return out;
})();

function inverseRate(rng: Rng): Built {
  const [x, y] = twoNames(rng);
  const [a, b, t] = rng.pick(INVERSE_TRIPLES);
  const job = rng.pick(['reconcile the month\'s statements', 'capture a batch of new accounts', 'check a shipment of devices']);
  return {
    prompt: `Working together, ${x} and ${y} can ${job} in ${t} hours. ${x} alone would take ${a} hours. How long would ${y} take alone?`,
    answer: hours(b),
    distractors: [
      hours(a - t), // subtracted the times
      hours(2 * t), // assumed equal speeds
      hours(a + t), // added the times
      hours(Math.round((a + t) / 2)),
      hours(b + 2),
      hours(Math.max(1, b - 2)),
    ],
    fallback: () => hours(b + rng.int(3, 12)),
    meta: { variant: 'inverse_rate', a, b, t },
  };
}

/** Format m x 10^p (m is 10..99) as a rand amount, e.g. (19, 6) -> "R19 million". */
export function formatMagnitude(m: number, p: number): string {
  const digits = (shift: number) => {
    // m * 10^shift, where shift >= -1
    if (shift >= 0) return commas(m * 10 ** shift);
    const s = `${Math.floor(m / 10)}.${m % 10}`;
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (p + 1 >= 9) return `R${digits(p - 9)} billion`;
  if (p + 1 >= 6) return `R${digits(p - 6)} million`;
  return `R${commas(m * 10 ** p)}`;
}

/** Round a positive integer to 2 significant figures: returns [m, p] with value = m * 10^p, 10 <= m <= 99. */
export function twoSigFigs(v: number): [number, number] {
  let p = Math.floor(Math.log10(v)) - 1;
  let m = Math.round(v / 10 ** p);
  if (m >= 100) {
    m = Math.round(m / 10);
    p += 1;
  }
  return [m, p];
}

function estimate(rng: Rng): Built {
  const accounts = rng.int(12, 96) * 100;
  const lines = rng.int(2, 6);
  const price = rng.pick([49, 79, 99, 129, 149, 199, 249, 299, 349, 399, 499]);
  const exact = accounts * lines * price * 12;
  const [m, p] = twoSigFigs(exact);
  // Ladder of 5 amounts a factor of 10 apart; the answer's place in the ladder is random.
  // Keep the ladder between R1,000-ish and R990 billion so every option reads naturally.
  const below = rng.int(Math.max(0, p - 6), Math.min(4, p - 2));
  const ladder = [0, 1, 2, 3, 4].map((i) => `About ${formatMagnitude(m, p - below + i)}`);
  const answer = ladder[below] as string;
  return {
    prompt: `A business customer has ${commas(accounts)} accounts. Each account has ${lines} phone lines, and each line costs R${price} a month. Roughly how much does the customer pay in a year?`,
    answer,
    distractors: ladder.filter((o) => o !== answer),
    fallback: () => answer, // never needed: the ladder always gives 4 others
    meta: { variant: 'estimate', accounts, lines, price, exact },
  };
}

const BY_TIER: Record<Tier, ((rng: Rng) => Built)[]> = {
  easy: [workRate],
  medium: [ratio, pctSuccessive],
  hard: [inverseRate, estimate],
};

export const wordProblem: Generator = (seed, tier) => {
  const rng = createRng(seed);
  const b = rng.pick(BY_TIER[tier])(rng);
  const { options, answerIndex } = buildOptions(rng, b.answer, b.distractors, b.fallback);
  return { family: 'word_problem', tier, stem: { prompt: b.prompt }, options, answerIndex, meta: b.meta };
};
