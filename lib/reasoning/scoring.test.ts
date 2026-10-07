import { describe, expect, it } from 'vitest';
import {
  normalCdf,
  percentileFromEmpirical,
  percentileFromNormal,
  PROVISIONAL_NORM,
  rawScore,
  scoreAttempt,
  starsFromPercentile,
} from './scoring';

describe('rawScore', () => {
  it('counts only correct answers; skipped (null) counts as wrong', () => {
    expect(rawScore([])).toBe(0);
    expect(rawScore([{ correct: true }, { correct: false }, { correct: null }, { correct: true }])).toBe(2);
    expect(rawScore(Array.from({ length: 30 }, () => ({ correct: null })))).toBe(0);
  });
});

describe('normalCdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024998, 5);
    expect(normalCdf(-0.3)).toBeCloseTo(0.382089, 5);
  });
});

describe('starsFromPercentile', () => {
  it.each([
    [0, 1], [19.9, 1], [20, 2], [39.9, 2], [40, 3], [59.9, 3],
    [60, 4], [79.9, 4], [80, 5], [94.9, 5], [95, 6], [100, 6],
  ])('%s -> %s stars', (p, stars) => {
    expect(starsFromPercentile(p)).toBe(stars);
  });
});

describe('percentileFromNormal (provisional norm)', () => {
  const pct = (raw: number) => percentileFromNormal(raw, PROVISIONAL_NORM.mean, PROVISIONAL_NORM.sd);

  it('puts the mean at the 50th percentile', () => {
    expect(pct(13.5)).toBe(50);
  });

  it('raw 12 -> 38.2 -> 2 stars; raw 13 -> 46.0 -> 3 stars', () => {
    expect(pct(12)).toBe(38.2);
    expect(starsFromPercentile(pct(12))).toBe(2);
    expect(pct(13)).toBe(46);
    expect(starsFromPercentile(pct(13))).toBe(3);
  });

  it('stays within [0, 100] at the extremes and is monotonic', () => {
    expect(pct(0)).toBeGreaterThanOrEqual(0);
    expect(pct(0)).toBeLessThan(1);
    expect(pct(30)).toBeLessThanOrEqual(100);
    expect(pct(30)).toBeGreaterThan(99);
    expect(percentileFromNormal(-100, 13.5, 5)).toBe(0);
    expect(percentileFromNormal(100, 13.5, 5)).toBe(100);
    for (let r = 1; r <= 30; r++) expect(pct(r)).toBeGreaterThanOrEqual(pct(r - 1));
  });

  it('rejects a non-positive sd', () => {
    expect(() => percentileFromNormal(10, 13.5, 0)).toThrow();
  });
});

describe('percentileFromEmpirical', () => {
  it('uses mid-rank: (below + half of ties) / n', () => {
    const scores = [10, 12, 12, 14, 20];
    expect(percentileFromEmpirical(12, scores)).toBe(40); // (1 + 0.5*2) / 5
    expect(percentileFromEmpirical(5, scores)).toBe(0);
    expect(percentileFromEmpirical(25, scores)).toBe(100);
    expect(percentileFromEmpirical(20, scores)).toBe(90); // (4 + 0.5) / 5
    expect(percentileFromEmpirical(13, [10, 12, 15])).toBe(66.7);
  });

  it('throws on an empty norm group', () => {
    expect(() => percentileFromEmpirical(10, [])).toThrow();
  });
});

describe('scoreAttempt', () => {
  it('scores against the provisional norm and records its version', () => {
    expect(scoreAttempt(12)).toEqual({ raw: 12, percentile: 38.2, stars: 2, normVersion: 'provisional-normal-v1' });
    expect(scoreAttempt(13).stars).toBe(3);
    expect(scoreAttempt(0).stars).toBe(1);
    expect(scoreAttempt(30).stars).toBe(6);
  });

  it('rejects impossible raw scores', () => {
    expect(() => scoreAttempt(-1)).toThrow();
    expect(() => scoreAttempt(31)).toThrow();
    expect(() => scoreAttempt(12.5)).toThrow();
  });
});
