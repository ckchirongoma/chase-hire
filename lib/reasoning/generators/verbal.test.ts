import { describe, expect, it } from 'vitest';
import { CANNOT_TELL, RELATIONS, RULE_TEMPLATES, verbal, type RelationName } from './verbal';
import type { GeneratedItem } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const REL_NAMES = Object.keys(RELATIONS) as RelationName[];

describe('verbal relation bank', () => {
  it('has 15+ pairs per relation, with no word on both sides and no repeats', () => {
    for (const name of REL_NAMES) {
      const rel = RELATIONS[name];
      expect(rel.pairs.length).toBeGreaterThanOrEqual(15);
      const as = rel.pairs.map((p) => p[0]);
      const bs = rel.pairs.map((p) => p[1]);
      expect(new Set(as).size).toBe(as.length);
      expect(new Set(bs).size).toBe(bs.length);
      for (const a of as) expect(bs).not.toContain(a);
      for (const w of [...as, ...bs]) expect(w).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('medium relations carry a lure that is not a valid answer', () => {
    for (const name of REL_NAMES) {
      const rel = RELATIONS[name];
      if (rel.tier !== 'medium') continue;
      for (const p of rel.pairs) {
        expect(p).toHaveLength(3);
        expect(p[2]).not.toBe(p[1]);
        expect(p[2]).not.toBe(p[0]);
      }
    }
  });
});

/** Independent check of an analogy: (a,b) and (c,d) are pairs of the same relation, and no other option pairs with c. */
function checkAnalogy(item: GeneratedItem) {
  const m = item.meta as { relation: RelationName; a: string; b: string; c: string; d: string };
  const rel = RELATIONS[m.relation];
  expect(rel.tier).toBe(item.tier);
  const isPair = (x: string, y: string) => rel.pairs.some((p) => p[0] === x && p[1] === y);
  const isConflict = (x: string, y: string) => (rel.conflicts ?? []).some((p) => p[0] === x && p[1] === y);
  expect(isPair(m.a, m.b)).toBe(true);
  expect(isPair(m.c, m.d)).toBe(true);
  expect(m.a).not.toBe(m.c);
  expect(item.stem.prompt.toLowerCase()).toBe(`${m.a} is to ${m.b} as ${m.c} is to ?`.toLowerCase());
  expect(item.options[item.answerIndex]).toBe(m.d);
  for (const o of item.options) {
    if (o === m.d) continue;
    expect(isPair(m.c, o)).toBe(false);
    expect(isConflict(m.c, o)).toBe(false);
    expect(o).not.toBe(m.c);
  }
}

/**
 * Independent check of a conditional item by truth table: enumerate the worlds (P, Q) where
 * "if P then Q" and the stated fact both hold; an option must be true in every such world.
 */
function checkConditional(item: GeneratedItem) {
  const m = item.meta as { form: string; fact: string; statements: { p: string; notP: string; q: string; notQ: string; converse: string } };
  const s = m.statements;
  const evalStmt = (text: string, P: boolean, Q: boolean): boolean | null => {
    if (text === s.p) return P;
    if (text === s.notP) return !P;
    if (text === s.q) return Q;
    if (text === s.notQ) return !Q;
    return null; // converse / "cannot be determined": not a fact about this person
  };
  const worlds = [[true, true], [true, false], [false, true], [false, false]].filter(
    ([P, Q]) => (!P || Q) && evalStmt(m.fact, P!, Q!) === true,
  );
  expect(worlds.length).toBeGreaterThan(0);
  const mustBeTrue = item.options.filter((o) => {
    const vals = worlds.map(([P, Q]) => evalStmt(o, P!, Q!));
    return vals.every((v) => v === true);
  });
  const keyed = item.options[item.answerIndex];
  if (mustBeTrue.length === 0) expect(keyed).toBe(CANNOT_TELL);
  else expect(mustBeTrue).toEqual([keyed]);

  const lines = item.stem.prompt.split('\n');
  expect(RULE_TEMPLATES.map((t) => t.rule)).toContain(lines[0]);
  expect(lines[1]).toBe(m.fact);
  expect(item.options).toContain(CANNOT_TELL);
  expect(item.options).not.toContain(m.fact); // never restate the given fact as an option
}

describe('verbal generator', () => {
  it('easy and medium: valid analogies with a unique answer', () => {
    for (const tier of ['easy', 'medium'] as const) {
      for (const seed of SEEDS) {
        const item = verbal(seed, tier);
        expect((item.meta as { kind: string }).kind).toBe('analogy');
        checkAnalogy(item);
      }
    }
  });

  it('hard: conditional logic keyed correctly (truth table), all four forms used', () => {
    const forms = new Set<string>();
    let cannotTell = 0;
    for (const seed of SEEDS) {
      const item = verbal(seed, 'hard');
      expect((item.meta as { kind: string }).kind).toBe('conditional');
      forms.add((item.meta as { form: string }).form);
      checkConditional(item);
      if (item.options[item.answerIndex] === CANNOT_TELL) cannotTell++;
    }
    expect([...forms].sort()).toEqual(['affirming_consequent', 'denying_antecedent', 'modus_ponens', 'modus_tollens']);
    // "Cannot be determined" should be right about half the time, so it is not a giveaway either way.
    expect(cannotTell / SEEDS.length).toBeGreaterThan(0.35);
    expect(cannotTell / SEEDS.length).toBeLessThan(0.65);
  });

  it('keeps reading load low: short sentences', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const item = verbal(seed, 'hard');
      for (const sentence of [...item.stem.prompt.split('\n'), ...item.options]) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(14);
      }
    }
  });
});
