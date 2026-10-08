import type { Rng } from './rng';

const MAX_FALLBACK_CALLS = 200;

/**
 * Turn an answer plus candidate distractors into 5 shuffled, distinct options.
 * Distractors are taken in priority order; duplicates, blanks and anything equal to
 * the answer are dropped. `fallback()` tops the list up to 4 distractors.
 */
export function buildOptions(
  rng: Rng,
  answer: string,
  distractors: string[],
  fallback: () => string,
): { options: string[]; answerIndex: number } {
  if (answer.trim() === '') throw new Error('buildOptions: empty answer');
  const chosen: string[] = [];
  const seen = new Set<string>([answer]);
  const tryAdd = (d: string) => {
    if (chosen.length >= 4 || d.trim() === '' || seen.has(d)) return;
    seen.add(d);
    chosen.push(d);
  };

  for (const d of distractors) tryAdd(d);
  for (let i = 0; chosen.length < 4 && i < MAX_FALLBACK_CALLS; i++) tryAdd(fallback());
  if (chosen.length < 4) {
    throw new Error(`buildOptions: could not find 4 distinct distractors for "${answer}"`);
  }

  const options = rng.shuffle([answer, ...chosen]);
  return { options, answerIndex: options.indexOf(answer) };
}
