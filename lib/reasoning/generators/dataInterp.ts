import type { Generator, ItemStem, Tier } from '../types';
import { createRng, type Rng } from '../rng';
import { buildOptions } from '../options';
import { commas, pct, rand } from '../format';

export type DataVariant = 'range' | 'pct_change' | 'share' | 'scaled_month_total' | 'scaled_region_avg';

const PROVINCES = [
  'Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State',
  'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape',
] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const RAND_TITLES = ['monthly renewal revenue by region', 'monthly airtime sales by region', 'monthly collections by region'];
const COUNT_TITLES = ['new contracts signed by region', 'support tickets closed by region', 'devices sold by region'];

type Unit = 'rand' | 'count';

interface Table {
  regions: string[];
  months: string[]; // full month names, 5 consecutive
  values: number[][]; // [region][month]
}

function pickFrame(rng: Rng): { regions: string[]; months: string[] } {
  const regions = rng.shuffle(PROVINCES).slice(0, 4);
  const m0 = rng.int(0, 7);
  return { regions, months: MONTHS.slice(m0, m0 + 5) };
}

const column = (t: Table, m: number) => t.values.map((row) => row[m] as number);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Percentage, exact to 1 decimal whenever the inputs allow it (avoids float noise). */
const percent = (num: number, den: number) => Math.round((num * 1000) / den) / 10;

/** Drop distractors so far from the answer that nobody would pick them (e.g. +100% next to +8%). */
const plausible = (ans: number, xs: number[]) => xs.filter((x) => Math.abs(x) <= Math.max(45, 2.5 * Math.abs(ans)));

/** Split `total` into 4 parts, each a multiple of `unit`, each between ~12% and ~40% of the total. */
function splitTotal(rng: Rng, total: number, unit: number): number[] {
  for (let tries = 0; tries < 1000; tries++) {
    const parts: number[] = [];
    for (let i = 0; i < 3; i++) parts.push(Math.round((total * rng.int(15, 33)) / 100 / unit) * unit);
    const rest = total - sum(parts);
    if (rest >= total * 0.12 && rest <= total * 0.4) return rng.shuffle([...parts, rest]);
  }
  throw new Error('splitTotal: failed');
}

/** One random value near `centre` (+/-40%), a multiple of `unit`. */
const near = (rng: Rng, centre: number, unit: number) =>
  Math.max(unit, Math.round((centre * rng.int(60, 140)) / 100 / unit) * unit);

function fillTable(rng: Rng, centre: number, unit: number, fixed: Map<number, number[]>): number[][] {
  const months = 5;
  const cols: number[][] = [];
  for (let m = 0; m < months; m++) cols.push(fixed.get(m) ?? [0, 1, 2, 3].map(() => near(rng, centre, unit)));
  return [0, 1, 2, 3].map((r) => cols.map((c) => c[r] as number));
}

function render(t: Table, unit: Unit | 'thousands'): ItemStem['table'] {
  const fmt = (v: number) => (unit === 'rand' ? rand(v) : commas(v));
  return {
    columns: ['Region', ...t.months.map((m) => m.slice(0, 3))],
    rows: t.regions.map((reg, r) => [reg, ...(t.values[r] as number[]).map(fmt)]),
  };
}

interface Built {
  table: Table;
  unit: Unit | 'thousands';
  title: string;
  question: string;
  footnote?: string;
  answer: string;
  distractors: string[];
  fallback: () => string;
  meta: Record<string, unknown>;
}

// ---------- easy: highest minus lowest month for one region ----------

function rangeItem(rng: Rng): Built {
  const unit: Unit = rng.pick(['rand', 'count'] as const);
  const { regions, months } = pickFrame(rng);
  const [lo, hi, step] = unit === 'rand' ? [10000, 30000, 50] : [40, 400, 1];
  const values = regions.map(() => {
    const row = new Set<number>();
    while (row.size < 5) row.add(rng.int(lo / step, hi / step) * step);
    return rng.shuffle([...row]);
  });
  const t: Table = { regions, months, values };
  const r = rng.int(0, 3);
  const range = (row: number[]) => Math.max(...row) - Math.min(...row);
  const row = values[r] as number[];
  const sorted = [...row].sort((a, b) => a - b);
  const fmt = (v: number) => (unit === 'rand' ? rand(v) : commas(v));
  const otherRows = rng.shuffle([0, 1, 2, 3].filter((i) => i !== r));
  return {
    table: t,
    unit,
    title: rng.pick(unit === 'rand' ? RAND_TITLES : COUNT_TITLES),
    question: `What is the difference between ${regions[r]}'s highest month and its lowest month?`,
    answer: fmt(range(row)),
    distractors: [
      (sorted[4] as number) - (sorted[1] as number), // used the second-lowest month
      range(values[otherRows[0] as number] as number[]), // wrong row
      Math.abs((row[0] as number) - (row[4] as number)), // first vs last month
      (sorted[3] as number) - (sorted[0] as number), // used the second-highest month
      range(values[otherRows[1] as number] as number[]),
    ].map(fmt),
    fallback: () => fmt(range(row) + rng.pick([-3, -2, -1, 1, 2, 3]) * step * rng.int(1, 20)),
    meta: { variant: 'range', unit, region: r },
  };
}

// ---------- medium ----------

/** Round column totals that keep every share/percentage exact to 1 decimal. [total, unit] */
const ROUND_TOTALS: Record<Unit, [number, number][]> = {
  count: [[200, 1], [250, 1], [400, 2], [500, 1], [1000, 1]],
  rand: [[50000, 50], [100000, 100], [200000, 200], [250000, 250]],
};

function pctChangeItem(rng: Rng): Built {
  const unit: Unit = rng.pick(['rand', 'count'] as const);
  const [t1, u] = rng.pick(ROUND_TOTALS[unit]);
  const sign = rng.next() < 0.3 ? -1 : 1;
  const t2 = t1 + sign * Math.round((t1 * rng.int(40, 300)) / 1000 / u) * u; // 4% to 30% change
  const i = rng.int(0, 2);
  const j = rng.int(i + 1, 4);
  const { regions, months } = pickFrame(rng);
  const values = fillTable(rng, t1 / 4, u, new Map([[i, splitTotal(rng, t1, u)], [j, splitTotal(rng, t2, u)]]));
  const t: Table = { regions, months, values };
  const T = (m: number) => sum(column(t, m));
  const r = rng.int(0, 3);
  const v = (m: number) => (values[r] as number[])[m] as number;
  const jAlt = rng.pick([0, 1, 2, 3, 4].filter((x) => x !== i && x !== j));
  const ans = percent(t2 - t1, t1);
  return {
    table: t,
    unit,
    title: rng.pick(unit === 'rand' ? RAND_TITLES : COUNT_TITLES),
    question: `By what percentage did the combined total for all four regions change from ${months[i]} to ${months[j]}?`,
    answer: pct(ans, true),
    distractors: plausible(ans, [
      percent(t2 - t1, t2), // % of the wrong base
      percent(v(j) - v(i), v(i)), // one region instead of the total
      percent(T(jAlt) - t1, t1), // wrong month
      -ans, // direction reversed
    ]).map((x) => pct(x, true)),
    fallback: () => pct(ans + rng.pick([-1, 1]) * rng.int(5, 80) / 10, true),
    meta: { variant: 'pct_change', unit, fromMonth: i, toMonth: j },
  };
}

function shareItem(rng: Rng): Built {
  const unit: Unit = rng.pick(['rand', 'count'] as const);
  const [total, u] = rng.pick(ROUND_TOTALS[unit]);
  const m = rng.int(0, 4);
  const { regions, months } = pickFrame(rng);
  const values = fillTable(rng, total / 4, u, new Map([[m, splitTotal(rng, total, u)]]));
  const t: Table = { regions, months, values };
  const r = rng.int(0, 3);
  const v = (values[r] as number[])[m] as number;
  const otherR = rng.pick([0, 1, 2, 3].filter((x) => x !== r));
  const otherM = rng.pick([0, 1, 2, 3, 4].filter((x) => x !== m));
  const ans = percent(v, total);
  return {
    table: t,
    unit,
    title: rng.pick(unit === 'rand' ? RAND_TITLES : COUNT_TITLES),
    question: `What share of the ${months[m]} total for all four regions came from ${regions[r]}?`,
    answer: pct(ans),
    distractors: plausible(ans, [
      percent(v, total - v), // compared with the other regions instead of the total
      percent(v, sum(values[r] as number[])), // share of the region's own row
      percent((values[r] as number[])[otherM] as number, sum(column(t, otherM))), // wrong month
      percent((values[otherR] as number[])[m] as number, total), // wrong row
      100 - ans, // complement
    ]).map((x) => pct(x)),
    fallback: () => pct(Math.max(0.5, ans + rng.pick([-1, 1]) * rng.int(5, 60) / 10)),
    meta: { variant: 'share', unit, region: r, month: m },
  };
}

// ---------- hard: footnote says the figures are in R'000 ----------

function scaledTable(rng: Rng): Table {
  const { regions, months } = pickFrame(rng);
  const values = regions.map(() => months.map(() => rng.int(300, 2500)));
  return { regions, months, values };
}

function scaledMonthTotal(rng: Rng): Built {
  const t = scaledTable(rng);
  const m = rng.int(0, 4);
  const mAlt = m === 4 ? 3 : m + 1;
  const total = sum(column(t, m));
  const dropRow = rng.int(0, 3);
  return {
    table: t,
    unit: 'thousands',
    title: rng.pick(RAND_TITLES),
    question: `What was the combined total for all four regions in ${t.months[m]}, in rand?`,
    footnote: "Figures in R'000.",
    answer: rand(total * 1000),
    distractors: [
      rand(total), // ignored the footnote
      rand(sum(column(t, mAlt)) * 1000), // wrong month
      rand((total - ((t.values[dropRow] as number[])[m] as number)) * 1000), // missed a row
      rand(total * 100), // wrong scale
      rand(sum(column(t, mAlt))),
    ],
    fallback: () => rand((total + rng.pick([-1, 1]) * rng.int(10, 300)) * 1000),
    meta: { variant: 'scaled_month_total', month: m, scale: 1000 },
  };
}

function scaledRegionAvg(rng: Rng): Built {
  const t = scaledTable(rng);
  const r = rng.int(0, 3);
  const row = t.values[r] as number[];
  // Nudge the last month so the row total divides evenly by 5.
  row[4] = (row[4] as number) + ((5 - (sum(row) % 5)) % 5);
  const rowSum = sum(row);
  const avg = rowSum / 5;
  const otherR = rng.pick([0, 1, 2, 3].filter((x) => x !== r));
  return {
    table: t,
    unit: 'thousands',
    title: rng.pick(RAND_TITLES),
    question: `What was ${t.regions[r]}'s average monthly figure over these five months, in rand?`,
    footnote: "Figures in R'000.",
    answer: rand(avg * 1000),
    distractors: [
      rand(avg), // ignored the footnote
      rand(rowSum * 1000), // forgot to divide
      rand(sum(t.values[otherR] as number[]) * 200), // wrong row (x1000 / 5)
      rand(rowSum * 250), // divided by 4 (x1000 / 4)
      rand(avg * 100), // wrong scale
    ],
    fallback: () => rand((avg + rng.pick([-1, 1]) * rng.int(5, 200)) * 1000),
    meta: { variant: 'scaled_region_avg', region: r, scale: 1000 },
  };
}

const BY_TIER: Record<Tier, ((rng: Rng) => Built)[]> = {
  easy: [rangeItem],
  medium: [pctChangeItem, shareItem],
  hard: [scaledMonthTotal, scaledRegionAvg],
};

export const dataInterp: Generator = (seed, tier) => {
  const rng = createRng(seed);
  const b = rng.pick(BY_TIER[tier])(rng);
  const { options, answerIndex } = buildOptions(rng, b.answer, b.distractors, b.fallback);
  const stem: ItemStem = {
    prompt: `The table shows ${b.title}.\n${b.question}`,
    table: render(b.table, b.unit),
  };
  if (b.footnote) stem.footnote = b.footnote;
  return { family: 'data_interp', tier, stem, options, answerIndex, meta: b.meta };
};
