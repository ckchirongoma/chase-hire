import { describe, expect, it } from "vitest";
import { normaliseForMatch, quoteAppears, unverifiedQuotes } from "@/lib/grading/quotes";

const subject = `I built the reporting pipeline in Python and dbt.
It cut the   weekly close from 3 days to 1 day — finance signed it off.
We rejected "Power BI" because licences cost R12,000 a year.`;

describe("quote verification", () => {
  it("matches verbatim quotes", () => {
    expect(quoteAppears("I built the reporting pipeline in Python and dbt.", subject)).toBe(true);
  });

  it("normalises whitespace, line breaks, case and curly quotes/dashes", () => {
    expect(quoteAppears("python and dbt. It cut the weekly close", subject)).toBe(true);
    expect(quoteAppears("from 3 days to 1 day - finance signed it off", subject)).toBe(true);
    expect(quoteAppears("We rejected “Power BI” because", subject)).toBe(true);
    expect(quoteAppears("  \"I built the reporting pipeline\"  ", subject)).toBe(true);
  });

  it("accepts elided quotes when every fragment appears in order", () => {
    expect(quoteAppears("I built the reporting pipeline … finance signed it off", subject)).toBe(true);
    expect(quoteAppears("I built the reporting pipeline ... R12,000 a year", subject)).toBe(true);
    expect(quoteAppears("finance signed it off ... I built the reporting pipeline", subject)).toBe(false);
  });

  it("rejects paraphrases, invented text and empty quotes", () => {
    expect(quoteAppears("I personally built the whole pipeline", subject)).toBe(false);
    expect(quoteAppears("saved 20 hours a week", subject)).toBe(false);
    expect(quoteAppears("", subject)).toBe(false);
    expect(quoteAppears("…", subject)).toBe(false);
  });

  it("lists only the unverified quotes", () => {
    expect(unverifiedQuotes([{ quote: "cut the weekly close" }, { quote: "made up" }], subject)).toEqual(["made up"]);
  });

  it("strips zero-width characters before matching", () => {
    expect(normaliseForMatch("Py​thon")).toBe("python");
    expect(quoteAppears("Py​thon and dbt", subject)).toBe(true);
  });
});
