import { describe, expect, it } from "vitest";
import { DocumentError, looksBinary, readDocument } from "@/lib/work/documents";
import { storableText } from "@/lib/work/text";

describe("storableText (what Postgres text/jsonb can hold)", () => {
  it("removes NUL and other C0 controls, keeps tabs, newlines and visible text", () => {
    expect(storableText("a\u0000b\u0007c\u001Fd\u007Fe")).toBe("abcde");
    expect(storableText("col1\tcol2\nrow")).toBe("col1\tcol2\nrow");
    expect(storableText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("keeps zero-width characters (evidence for the sanitiser) and valid surrogate pairs", () => {
    expect(storableText("hid​den")).toBe("hid​den");
    expect(storableText("ok 😀")).toBe("ok 😀");
  });

  it("replaces unpaired surrogates so the JSON body stays valid", () => {
    expect(storableText("x\uD800y")).toBe("x\uFFFDy");
    expect(storableText("x\uDC00y")).toBe("x\uFFFDy");
    expect(JSON.parse(JSON.stringify(storableText("a\u0000\uD83Db")))).toBe("a\uFFFDb");
  });
});

describe("readDocument for Markdown and text", () => {
  it("refuses a NUL byte anywhere in the file, not just the first 8 KB", async () => {
    const buf = Buffer.concat([Buffer.from(`# Memo\n\n${"word ".repeat(2500)}`), Buffer.from([0x00]), Buffer.from("tail")]);
    expect(buf.length).toBeGreaterThan(8192);
    expect(looksBinary(buf)).toBe(true);
    const err = await readDocument(buf, "md").catch((e) => e);
    expect(err).toBeInstanceOf(DocumentError);
    expect((err as DocumentError).kind).toBe("binary");
  });

  it("reads UTF-8 text, drops a leading BOM and other control characters", async () => {
    const { text, pdfPages } = await readDocument(Buffer.from("\uFEFF# Memo\r\nbody\u0007 text"), "md");
    expect(text).toBe("# Memo\nbody text");
    expect(pdfPages).toBeNull();
  });
});
