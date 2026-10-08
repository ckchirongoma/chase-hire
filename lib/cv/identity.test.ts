import { describe, expect, it } from "vitest";
import {
  emailDedupeKey,
  githubHandle,
  isZaMobile,
  linkedinHandle,
  normaliseCvTextForEmbedding,
  normaliseEmail,
  normalisePhoneZA,
  sha256Hex,
} from "./identity";

describe("normalisePhoneZA", () => {
  const mobile = "+27832728600";
  const cases: [string, string | null][] = [
    ["(083) 272 8600", mobile],
    ["083 272 8600", mobile],
    ["0832728600", mobile],
    ["832728600", mobile],
    ["+27 83 272 8600", mobile],
    ["+27 (0)83 272 8600", mobile],
    ["27832728600", mobile],
    ["0027 83 272 8600", mobile],
    ["083-272-8600", mobile],
    ["082 555 0101", "+27825550101"],
    ["071 555 0199", "+27715550199"],
    ["021 555 1234", "+27215551234"],
    ["(011) 555-1234", "+27115551234"],
    ["0", null],
    ["", null],
    ["   ", null],
    ["083 272", null],
    ["083 272 8600 123", null],
    ["215551234", null], // 9 digits not starting 6/7/8: ambiguous, rejected
    ["0932728600", null], // no SA numbers start 09
    ["+44 20 7946 0958", "+442079460958"], // already international: kept as E.164
    ["not a phone", null],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(normalisePhoneZA(input)).toBe(expected);
    });
  }

  it("handles null and undefined", () => {
    expect(normalisePhoneZA(null)).toBeNull();
    expect(normalisePhoneZA(undefined)).toBeNull();
  });
});

describe("isZaMobile", () => {
  it("accepts +276x, +277x and +278x", () => {
    expect(isZaMobile("+27615550101")).toBe(true);
    expect(isZaMobile("+27715550101")).toBe(true);
    expect(isZaMobile("+27832728600")).toBe(true);
  });
  it("rejects landlines, other countries and junk", () => {
    expect(isZaMobile("+27215551234")).toBe(false);
    expect(isZaMobile("+442079460958")).toBe(false);
    expect(isZaMobile("0832728600")).toBe(false);
    expect(isZaMobile(null)).toBe(false);
  });
});

describe("normaliseEmail / emailDedupeKey", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Test.Candidate@Example.CO.ZA ")).toBe("test.candidate@example.co.za");
    expect(normaliseEmail("mailto:a@b.co")).toBe("a@b.co");
  });
  it("returns null for invalid input", () => {
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail("a b@c.com")).toBeNull();
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
  it("dedupe key drops +tags and Gmail dots", () => {
    expect(emailDedupeKey("Test.Candidate+round2@gmail.com")).toBe("testcandidate@gmail.com");
    expect(emailDedupeKey("t.c@googlemail.com")).toBe("tc@gmail.com");
    expect(emailDedupeKey("test.candidate+x@example.co.za")).toBe("test.candidate@example.co.za");
    expect(emailDedupeKey("+x@example.com")).toBeNull();
  });
});

describe("linkedinHandle", () => {
  const cases: [string, string | null][] = [
    ["https://www.linkedin.com/in/Test-Candidate/", "test-candidate"],
    ["linkedin.com/in/test-candidate", "test-candidate"],
    ["http://linkedin.com/in/test-candidate?utm_source=share", "test-candidate"],
    ["https://za.linkedin.com/in/test-candidate#about", "test-candidate"],
    ["LinkedIn: www.linkedin.com/in/jane-doe-1a2b3c", "jane-doe-1a2b3c"],
    ["https://www.linkedin.com/company/example", null],
    ["https://notlinkedin.com/in/someone", null],
    ["LinkedIn", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => expect(linkedinHandle(input)).toBe(expected));
  }
});

describe("githubHandle", () => {
  const cases: [string, string | null][] = [
    ["https://github.com/Ayanda-Fixture", "ayanda-fixture"],
    ["github.com/ayanda-fixture/", "ayanda-fixture"],
    ["https://www.github.com/ayanda-fixture/some-repo/tree/main", "ayanda-fixture"],
    ["http://github.com/ayanda-fixture?tab=repositories", "ayanda-fixture"],
    ["https://github.com/orgs/example/repositories", null],
    ["https://github.com/", null],
    ["https://gitlab.com/someone", null],
    ["GitHub", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => expect(githubHandle(input)).toBe(expected));
  }
});

describe("normaliseCvTextForEmbedding", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normaliseCvTextForEmbedding("  Test   CANDIDATE\n\n\tBA  ")).toBe("test candidate ba");
  });
  it("caps the text at 8000 characters", () => {
    expect(normaliseCvTextForEmbedding("a ".repeat(10_000))).toHaveLength(8000);
  });
});

describe("sha256Hex", () => {
  it("hashes a buffer", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
