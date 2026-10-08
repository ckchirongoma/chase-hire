import { describe, expect, it } from "vitest";
import { appendixKey, appendixShareSuspicious, bodyText, bodyWordCount, countWords, estimatePages, splitBody } from "@/lib/work/count";

describe("countWords", () => {
  it("counts tokens with a letter or digit, not bullets or table pipes", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  one two\tthree\nfour ")).toBe(4);
    expect(countWords("- item | 42 | R1,200 — done")).toBe(4);
    expect(countWords("POPIA s69(3) e.g. don't")).toBe(4);
    expect(countWords("Ünïcode wörds ✓ count")).toBe(3);
  });
});

describe("bodyWordCount (words before the first line starting with “Appendix”)", () => {
  const memo = ["Executive summary", "Fix contactability first.", "", "Appendix A: Gap log", "Gap | Evidence", "Appendix B: Questions"].join("\n");

  it("stops at the first Appendix line", () => {
    expect(bodyText(memo)).toBe("Executive summary\nFix contactability first.\n");
    expect(bodyWordCount(memo)).toBe(5);
  });

  it("matches headings, numbering, emphasis and case variants", () => {
    for (const line of ["## Appendix A", "APPENDIX", "**Appendix A: gaps**", "  appendices", "7. Appendix: questions", "> Appendix"]) {
      expect(bodyWordCount(`one two three\n${line}\nfour five`)).toBe(3);
    }
  });

  it("ignores 'Appendix' in the middle of a line, and words that merely start with it", () => {
    expect(bodyWordCount("See Appendix A for the gap log.\nMore text")).toBe(9);
    expect(bodyWordCount("Appendixes aside\nthree")).toBe(3);
  });

  it("counts everything when there is no appendix", () => {
    expect(bodyWordCount("a b c d")).toBe(4);
  });

  it("a 1,501-word body is over a 1,500 limit regardless of appendix length", () => {
    const body = Array.from({ length: 1501 }, (_, i) => `w${i}`).join(" ");
    const appendix = Array.from({ length: 3000 }, () => "x").join(" ");
    expect(bodyWordCount(`${body}\nAppendix A\n${appendix}`)).toBe(1501);
  });
});

describe("contents lists and appendix overviews are not the start of the appendices", () => {
  const body = (n: number, tag = "b") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

  it("the reviewer's case: a contents block listing the appendices, then 3,000 words", () => {
    const text = `Contents\n1. Executive summary\n2. Purpose\nAppendix A: Gap log\nAppendix B: Questions\n\n${body(3000)}`;
    const split = splitBody(text);
    expect(split).toMatchObject({ cutLine: null, totalWords: 3013, bodyWords: 3013 });
    expect(split.listed).toEqual([3, 4]);
    expect(bodyWordCount(text)).toBeGreaterThan(1500);
  });

  it("a contents block with page numbers, then the real appendix heading later", () => {
    const text = [
      "Table of contents",
      "Executive summary ........ 1",
      "Appendix A: Gap log ........ 5",
      "Appendix B: Questions ........ 6",
      "",
      "Executive summary",
      body(200),
      "Appendix A: Gap log",
      body(900, "a"),
    ].join("\n");
    const split = splitBody(text);
    expect(split.cutLine).toBe(7);
    // Dot leaders aren't words: 3 + 3 + 5 + 4 + 2 + 200.
    expect(split.bodyWords).toBe(217);
  });

  it("DOCX-style contents (entries separated by blank lines) end at the first repeated heading", () => {
    const text = ["Contents", "", "1. Executive summary", "", "2. Spiky POV", "", "Appendix A – Gap log", "", "Appendix B – Questions", "", "Executive summary", "", body(300), "", "Appendix A – Gap log", "", body(800, "a")].join("\n");
    const split = splitBody(text);
    expect(split.cutLine).toBe(14);
    // Dashes aren't words: 1 + 3 + 3 + 4 + 3 + 2 + 300.
    expect(split.bodyWords).toBe(316);
  });

  it("a back-to-back list of appendices near the top is skipped; a later single heading still cuts", () => {
    const text = `Appendix A: Gap log\nAppendix B: Questions\n\n${body(400)}\nAppendix A: Gap log\n${body(2000, "a")}`;
    expect(splitBody(text)).toMatchObject({ cutLine: 4, bodyWords: 4 + 3 + 400 });
  });

  it("real appendix headings at the end still cut, even back to back or under an 'Appendices' heading", () => {
    const empties = `${body(1400)}\nAppendix A: Gap log\nAppendix B: Questions\n${body(300, "q")}`;
    expect(splitBody(empties)).toMatchObject({ cutLine: 1, bodyWords: 1400 });
    const nested = `${body(1400)}\n## Appendices\n### Appendix A: Gap log\n${body(2000, "a")}\n### Appendix B: Questions\n${body(100, "q")}`;
    expect(splitBody(nested)).toMatchObject({ cutLine: 1, bodyWords: 1400 });
    const single = `${body(1400)}\nAppendix A\n${body(3000, "a")}`;
    expect(splitBody(single)).toMatchObject({ cutLine: 1, bodyWords: 1400, totalWords: 4402 });
  });

  it("keys appendices by letter or number", () => {
    expect(appendixKey("Appendix A: Gap log")).toBe("appendix a");
    expect(appendixKey("## Appendix B – Questions")).toBe("appendix b");
    expect(appendixKey("Appendix 2. Data")).toBe("appendix 2");
    expect(appendixKey("APPENDIX II")).toBe("appendix ii");
    expect(appendixKey("Appendices")).toBe("appendix");
    expect(appendixKey("Appendix: questions")).toBe("appendix");
  });

  it("flags an implausibly large appendix share for a person to check (no rejection)", () => {
    // An early one-line overview is still a cut, so the body is tiny: flagged, not rejected.
    const overview = splitBody(`Appendices: A gap log, B questions\n\n${body(3000)}`);
    expect(overview).toMatchObject({ cutLine: 0, bodyWords: 0, totalWords: 3006 });
    expect(appendixShareSuspicious(overview, 1500)).toBe(true);
    // A normal memo with a long appendix is fine.
    expect(appendixShareSuspicious(splitBody(`${body(1400)}\nAppendix A\n${body(2000, "a")}`), 1500)).toBe(false);
    // Under the limit in total, or no limit: never flagged.
    expect(appendixShareSuspicious({ bodyWords: 10, totalWords: 1400 }, 1500)).toBe(false);
    expect(appendixShareSuspicious({ bodyWords: 10, totalWords: 9000 }, null)).toBe(false);
  });
});

describe("estimatePages", () => {
  it("is ceil(words / 500), and 0 for empty", () => {
    expect(estimatePages(0)).toBe(0);
    expect(estimatePages(1)).toBe(1);
    expect(estimatePages(500)).toBe(1);
    expect(estimatePages(501)).toBe(2);
    expect(estimatePages(3000)).toBe(6);
    expect(estimatePages(3001)).toBe(7);
  });
});
