// Shared types for the Reasoning Assessment (job-related problem-solving items).

export type Family =
  | 'number_series'
  | 'data_interp'
  | 'deduction'
  | 'letter_series'
  | 'verbal'
  | 'word_problem';

export type Tier = 'easy' | 'medium' | 'hard';

export interface ItemStem {
  /** Plain text: the question. */
  prompt: string;
  /** Used by data_interp. */
  table?: { columns: string[]; rows: (string | number)[][] };
  footnote?: string;
}

export interface GeneratedItem {
  family: Family;
  tier: Tier;
  stem: ItemStem;
  /** Exactly 5 distinct strings. */
  options: string[];
  /** 0..4 */
  answerIndex: number;
  /** Rule and parameters used, for debugging, admin review and tests. */
  meta?: Record<string, unknown>;
}

export type Generator = (seed: number, tier: Tier) => GeneratedItem;
