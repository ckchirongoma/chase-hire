import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCX_MIME, extractText, PDF_MIME } from "./extract";

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures", name));

describe("extractText", () => {
  it("extracts text from a PDF", async () => {
    const text = await extractText(fixture("cv-sample.pdf"), PDF_MIME);
    expect(text).toContain("Test Candidate");
    expect(text).toContain("test.candidate@example.co.za");
    expect(text).toContain("082 555 0101");
    expect(text).toContain("linkedin.com/in/test-candidate");
    expect(text).toBe(text.trim());
  });

  it("extracts a different person's PDF", async () => {
    const text = await extractText(fixture("cv-sample-2.pdf"), PDF_MIME);
    expect(text).toContain("Ayanda Fixture");
    expect(text).not.toContain("Test Candidate");
  });

  it("extracts text from a DOCX", async () => {
    const text = await extractText(fixture("cv-sample.docx"), DOCX_MIME);
    expect(text).toContain("Test Candidate");
    expect(text).toContain("test.candidate@example.co.za");
  });

  it("returns an empty string for a PDF with no text layer", async () => {
    expect(await extractText(fixture("cv-scanned.pdf"), PDF_MIME)).toBe("");
  });

  it("throws for an unsupported mime type", async () => {
    await expect(extractText(Buffer.from("hello"), "text/plain")).rejects.toThrow(/unsupported/);
  });

  it("throws when the bytes do not match the declared type", async () => {
    await expect(extractText(fixture("cv-sample.docx"), PDF_MIME)).rejects.toThrow(/not a PDF/);
    await expect(extractText(fixture("cv-sample.pdf"), DOCX_MIME)).rejects.toThrow(/not a DOCX/);
  });
});
