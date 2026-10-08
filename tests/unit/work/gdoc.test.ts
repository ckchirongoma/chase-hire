import { describe, expect, it } from "vitest";
import { parseGoogleDocUrl, parseMaterials, TEMPLATE_MARKERS } from "@/lib/work/gdoc";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_01234";

describe("Google Doc links", () => {
  it("takes the document id from the usual link shapes", () => {
    for (const link of [
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/document/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/document/d/${ID}`,
      `https://docs.google.com/document/u/1/d/${ID}/view#heading=h.1`,
      `  https://docs.google.com/document/d/${ID}/copy  `,
    ]) {
      expect(parseGoogleDocUrl(link)).toEqual({ id: ID, url: `https://docs.google.com/document/d/${ID}/edit` });
    }
  });

  it("refuses anything that isn't a Google Docs document on docs.google.com over https", () => {
    for (const bad of [
      null,
      42,
      "",
      "not a url",
      `http://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com.attacker.example/document/d/${ID}/edit`,
      `https://attacker.example/docs.google.com/document/d/${ID}`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com/document/d/abc/edit`,
      `https://docs.google.com/document/d/${ID}%2F..%2Fx/edit`,
    ]) {
      expect(parseGoogleDocUrl(bad)).toBeNull();
    }
  });

  it("materials: the copy link comes from the template; bad or missing links are dropped", () => {
    expect(parseMaterials({ instructions_url: "https://docs.google.com/document/d/x/edit", template_url: `https://docs.google.com/document/d/${ID}/edit?usp=sharing` })).toEqual({
      instructionsUrl: "https://docs.google.com/document/d/x/edit",
      templateUrl: `https://docs.google.com/document/d/${ID}/edit`,
      templateCopyUrl: `https://docs.google.com/document/d/${ID}/copy`,
    });
    expect(parseMaterials(null)).toEqual({ instructionsUrl: null, templateUrl: null, templateCopyUrl: null });
    expect(parseMaterials({ instructions_url: "javascript:alert(1)", template_url: "https://example.com/t" })).toEqual({
      instructionsUrl: null,
      templateUrl: null,
      templateCopyUrl: null,
    });
  });

  it("each BA template has its own marker", () => {
    expect(TEMPLATE_MARKERS).toEqual({ ba_part1: "CHASE-BA1", ba_part2: "CHASE-BA2" });
  });
});
