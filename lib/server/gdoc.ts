import "server-only";
import { MAX_UPLOAD_BYTES } from "@/lib/work/stages";

/**
 * Downloads a candidate's Google Doc as DOCX (Google's export link), which only works when the
 * doc is shared as "Anyone with the link". Only docs.google.com document ids are fetched (the URL
 * is built here, never taken from the candidate). GOOGLE_DOCS_BASE_URL exists for tests.
 */

export class GoogleDocError extends Error {
  constructor(
    message: string,
    public kind: "not_shared" | "too_large" | "timeout" | "unavailable",
  ) {
    super(message);
  }
}

export async function downloadGoogleDoc(id: string, budgetMs = 20_000): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(id)) throw new GoogleDocError("Not a Google Doc id", "unavailable");
  const base = process.env.GOOGLE_DOCS_BASE_URL || "https://docs.google.com";
  let res: Response;
  try {
    res = await fetch(`${base}/document/d/${id}/export?format=docx`, { redirect: "follow", signal: AbortSignal.timeout(budgetMs) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new GoogleDocError(timedOut ? "Google took too long to send the document" : "Could not reach Google Docs", timedOut ? "timeout" : "unavailable");
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new GoogleDocError(`Google answered ${res.status}`, "not_shared");
  if (!res.ok) throw new GoogleDocError(`Google answered ${res.status}`, "unavailable");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new GoogleDocError("The document is too large", "too_large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) throw new GoogleDocError("The document is too large", "too_large");
  // A doc that isn't shared redirects to a sign-in page (HTML), not a DOCX (a ZIP: "PK").
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new GoogleDocError("Google sent a sign-in page, not the document", "not_shared");
  return buf;
}
