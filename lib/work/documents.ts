import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { DOCX_MIME, extractText, PDF_MIME } from "@/lib/cv/extract";
import type { FileExt } from "./stages";
import { storableText } from "./text";

/**
 * Reads an uploaded work file (server side; uploads are hostile input). PDF and DOCX text comes
 * from lib/cv/extract (which checks magic bytes); Markdown and text files are read as UTF-8 and
 * refused if they contain a NUL byte anywhere. The returned text is storable (see storableText:
 * NUL and other control characters removed, e.g. from a PDF text layer); callers sanitise it.
 */

export class DocumentError extends Error {
  /** "binary": a .md/.txt upload that isn't text. */
  constructor(
    message: string,
    public kind: "binary" | "unreadable" = "unreadable",
  ) {
    super(message);
  }
}

/** Number of pages in a PDF (pdf-parse numpages), without extracting the text again. */
export async function pdfPageCount(buf: Buffer): Promise<number> {
  if (!buf.subarray(0, 1024).includes("%PDF-")) throw new DocumentError("not a PDF");
  // Plain Uint8Array copy (see lib/cv/extract for why), and a no-op page renderer: we only need the count.
  const res = await pdfParse(new Uint8Array(buf) as Buffer, { pagerender: async () => "" });
  return res.numpages;
}

/** A NUL byte anywhere means the file isn't UTF-8 text (UTF-8 text never contains 0x00). */
export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export async function readDocument(buf: Buffer, ext: FileExt): Promise<{ text: string; pdfPages: number | null }> {
  switch (ext) {
    case "pdf": {
      const [text, pages] = await Promise.all([extractText(buf, PDF_MIME), pdfPageCount(buf)]);
      return { text: storableText(text), pdfPages: pages };
    }
    case "docx":
      return { text: storableText(await extractText(buf, DOCX_MIME)), pdfPages: null };
    case "md":
    case "txt": {
      if (looksBinary(buf)) throw new DocumentError("not a text file", "binary");
      return { text: storableText(buf.toString("utf8").replace(/^\uFEFF/, "")), pdfPages: null };
    }
    default:
      throw new DocumentError(`cannot read .${ext} files as text`);
  }
}

/** Checks an image upload is what its extension says. */
export function checkImage(buf: Buffer, ext: FileExt): boolean {
  if (ext === "png") return isPng(buf);
  if (ext === "jpg" || ext === "jpeg") return isJpeg(buf);
  return false;
}
