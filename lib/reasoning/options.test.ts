import { describe, expect, it } from 'vitest';
import { buildOptions } from './options';
import { createRng } from './rng';

describe('buildOptions', () => {
  it('drops duplicates, blanks and copies of the answer, keeping priority order', () => {
    const { options, answerIndex } = buildOptions(createRng(1), '10', ['12', '10', '12', '', '8', '9', '11', '13'], () => '99');
    expect(options).toHaveLength(5);
    expect(options[answerIndex]).toBe('10');
    expect([...options].sort()).toEqual(['10', '11', '12', '8', '9']);
  });

  it('tops up with the fallback', () => {
    let n = 0;
    const { options } = buildOptions(createRng(2), 'A', ['B'], () => ['B', 'C', 'C', 'D', 'E'][n++ % 5]!);
    expect([...options].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('throws instead of looping forever when the fallback cannot help', () => {
    expect(() => buildOptions(createRng(3), 'A', ['B'], () => 'B')).toThrow(/distinct distractors/);
  });

  it('shuffles the answer position', () => {
    const slots = new Set<number>();
    for (let s = 0; s < 50; s++) slots.add(buildOptions(createRng(s), 'X', ['a', 'b', 'c', 'd'], () => 'e').answerIndex);
    expect(slots.size).toBe(5);
  });
});
