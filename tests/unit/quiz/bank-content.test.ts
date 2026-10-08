import { describe, expect, it } from "vitest";
import { assembleQuiz } from "@/lib/quiz/assemble";
import { BANK_DEPTH_TARGET, BLUEPRINT, QUIZ_ROLES, topicsFor } from "@/lib/quiz/blueprint";
import { parseSeedItems, readSeedSql } from "./helpers";

// Content checks on the shipped quiz bank (supabase/migrations/20261007000010_quiz_bank_seed.sql).

const sql = readSeedSql();
const items = parseSeedItems(sql);

describe("quiz bank seed file", () => {
  it("parses every row in the VALUES list", () => {
    const rowStarts = sql.match(/^\('(software-engineer|business-analyst)', '/gm) ?? [];
    expect(items.length).toBe(rowStarts.length);
    expect(items.length).toBeGreaterThan(0);
  });

  it.each(QUIZ_ROLES)("%s has at least 64 items and blueprint x4 per topic", (role) => {
    const mine = items.filter((i) => i.role_slug === role);
    expect(mine.length).toBeGreaterThanOrEqual(64);
    for (const { topic, count } of BLUEPRINT[role]) {
      expect(mine.filter((i) => i.topic === topic).length, topic).toBeGreaterThanOrEqual(count * BANK_DEPTH_TARGET);
    }
    // Only blueprint topics.
    for (const i of mine) expect(topicsFor(role)).toContain(i.topic);
  });

  it.each(QUIZ_ROLES)("%s has about 15%% select-all items", (role) => {
    const mine = items.filter((i) => i.role_slug === role);
    const share = mine.filter((i) => i.multi).length / mine.length;
    expect(share).toBeGreaterThanOrEqual(0.1);
    expect(share).toBeLessThanOrEqual(0.2);
  });

  it("every item is well formed", () => {
    for (const i of items) {
      const where = `${i.role_slug}/${i.topic}: ${i.stem.slice(0, 60)}`;
      expect(i.options.length, where).toBeGreaterThanOrEqual(4);
      expect(i.options.length, where).toBeLessThanOrEqual(5);
      expect(new Set(i.options.map((o) => o.toLowerCase())).size, where).toBe(i.options.length);
      expect(i.options.every((o) => o.trim().length > 0), where).toBe(true);
      expect(new Set(i.answer_key).size, where).toBe(i.answer_key.length);
      for (const k of i.answer_key) {
        expect(Number.isInteger(k), where).toBe(true);
        expect(k, where).toBeGreaterThanOrEqual(0);
        expect(k, where).toBeLessThan(i.options.length);
      }
      if (i.multi) {
        expect(i.answer_key.length, where).toBeGreaterThanOrEqual(2);
        expect(i.answer_key.length, where).toBeLessThan(i.options.length);
      } else {
        expect(i.answer_key.length, where).toBe(1);
      }
      expect(i.stem.trim().length, where).toBeGreaterThan(15);
      expect(i.stem.length, where).toBeLessThanOrEqual(260); // low reading load
    }
  });

  it("has no duplicate stems within a role", () => {
    for (const role of QUIZ_ROLES) {
      const stems = items.filter((i) => i.role_slug === role).map((i) => i.stem.toLowerCase());
      expect(new Set(stems).size).toBe(stems.length);
    }
  });

  it("never refers to other options, since options are shuffled", () => {
    for (const i of items) {
      for (const o of i.options) {
        expect(o, i.stem).not.toMatch(/\b(all|none|both|neither) of the (above|below)\b/i);
        expect(o, i.stem).not.toMatch(/^(both|neither) [a-e]\b/i);
        expect(o, i.stem).not.toMatch(/\boption [a-e]\b/i);
      }
    }
  });

  it("contains no client names, real client figures or work-assessment answers", () => {
    const banned = [
      /kopano/i, /lerato/i, /mzansi/i, /cosmo/i, /gallo/i, /aurachain/i,
      /1,687/, /\b1687\b/, /17 of 127/, /2026\/13\/08/, /\b\d{4}\/1[3-9]\/\d{2}\b/,
      /NEXT_PUBLIC_SUPABASE_SERVICE_KEY/, /content id/i, /takedown/i,
    ];
    for (const re of banned) expect(sql, String(re)).not.toMatch(re);
  });

  it("assembles a valid quiz from the real bank for many seeds", () => {
    for (const role of QUIZ_ROLES) {
      const bank = items.filter((i) => i.role_slug === role);
      for (let seed = 1; seed <= 200; seed++) {
        const quiz = assembleQuiz(seed * 2654435761, bank);
        expect(quiz).toHaveLength(15);
        for (const { topic, count } of BLUEPRINT[role]) expect(quiz.filter((q) => q.topic === topic)).toHaveLength(count);
      }
    }
  });
});
