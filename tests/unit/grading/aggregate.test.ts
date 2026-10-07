import { describe, expect, it } from "vitest";
import { aggregate, closestIndex, criterionTo100, median, weightedMean } from "@/lib/grading/aggregate";

describe("median", () => {
  it("handles odd, even and empty lists without mutating input", () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
    expect(median([4, 2])).toBe(3);
    expect(median([2, 3, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("aggregate (3 samples → median, spread, review flag)", () => {
  it("takes the median and the max−min spread", () => {
    expect(aggregate([3, 4, 3])).toEqual({ median: 3, spread: 1, needsHumanReview: false });
  });

  it("flags a spread of 2 or more for human review", () => {
    expect(aggregate([2, 4, 3])).toEqual({ median: 3, spread: 2, needsHumanReview: true });
    expect(aggregate([1, 5, 5]).needsHumanReview).toBe(true);
  });

  it("does not flag a spread of 1 or identical scores", () => {
    expect(aggregate([4, 5, 5]).needsHumanReview).toBe(false);
    expect(aggregate([3, 3, 3])).toEqual({ median: 3, spread: 0, needsHumanReview: false });
  });

  it("treats no scores as needing review", () => {
    expect(aggregate([])).toEqual({ median: null, spread: null, needsHumanReview: true });
  });
});

describe("criterionTo100", () => {
  it("maps 1..5 onto 0..100 linearly and clamps", () => {
    expect(criterionTo100(1)).toBe(0);
    expect(criterionTo100(2)).toBe(25);
    expect(criterionTo100(3)).toBe(50);
    expect(criterionTo100(3.5)).toBe(62.5);
    expect(criterionTo100(5)).toBe(100);
    expect(criterionTo100(0)).toBe(0);
    expect(criterionTo100(9)).toBe(100);
  });
});

describe("weightedMean", () => {
  it("weights values and skips nulls", () => {
    expect(weightedMean([{ value: 100, weight: 1 }, { value: 0, weight: 3 }])).toBe(25);
    expect(weightedMean([{ value: 50, weight: 1 }, { value: null, weight: 5 }])).toBe(50);
  });
  it("falls back to a plain mean when all weights are 0, and null when empty", () => {
    expect(weightedMean([{ value: 10, weight: 0 }, { value: 30, weight: 0 }])).toBe(20);
    expect(weightedMean([])).toBeNull();
    expect(weightedMean([{ value: null, weight: 1 }])).toBeNull();
  });
});

describe("closestIndex", () => {
  it("returns the earliest value closest to the target", () => {
    expect(closestIndex([1, 3, 5], 3)).toBe(1);
    expect(closestIndex([2, 4], 3)).toBe(0);
    expect(closestIndex([], 3)).toBe(-1);
  });
});
