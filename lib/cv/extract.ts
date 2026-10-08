import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Extracts plain text from an uploaded CV (docs/01 §3).
 * Returns trimmed text, or "" when the file has no text layer (e.g. a scanned PDF);
 * the caller then falls back to the vision model.
 * The declared mime type is checked against the file's magic bytes, since uploads are hostile.
 */
export async function extractText(buf: Buffer, mime: string): Promise<string> {
  if (mime === PDF_MIME) {
    // The PDF spec allows the header anywhere in the first 1024 bytes.
    if (!buf.subarray(0, 1024).includes("%PDF-")) {
      throw new Error("extractText: file is not a PDF");
    }
    // Pass a plain Uint8Array copy, not a Buffer: pdf.js clones its input with
    // `new input.constructor(input)`, which for a Buffer under 4 KB yields a slice of Node's
    // shared pool (non-zero byteOffset) that pdf.js then misreads ("bad XRef entry").
    const result = await pdfParse(new Uint8Array(buf) as Buffer);
    return result.text.trim();
  }

  if (mime === DOCX_MIME) {
    // DOCX is a zip archive: "PK\x03\x04".
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
      throw new Error("extractText: file is not a DOCX");
    }
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value.trim();
  }

  throw new Error(`extractText: unsupported file type "${mime}" (PDF or DOCX only)`);
}
