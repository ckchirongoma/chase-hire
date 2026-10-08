import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { service } from "./local";

/**
 * A local stand-in for Google Docs' export link (GOOGLE_DOCS_BASE_URL), so tests never touch the
 * internet. gdoc(buffer) registers a "shared" doc and returns its docs.google.com link; "private"
 * answers like an unshared doc (a sign-in page); unknown ids are 404s. Also sets the BA stages'
 * template links, without which those stages can't start.
 */

export const TEMPLATE_IDS = { ba_part1: "TemplateBa1ForIntegrationTests01", ba_part2: "TemplateBa2ForIntegrationTests01" } as const;

const docs = new Map<string, Buffer | "private">();
let server: http.Server | null = null;
let previous: string | undefined;

export async function startGoogleDocs(): Promise<void> {
  server = http.createServer((req, res) => {
    const m = (req.url ?? "").match(/^\/document\/d\/([A-Za-z0-9_-]+)\/export\?format=docx$/);
    const doc = m ? docs.get(m[1]) : undefined;
    if (doc === undefined) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    if (doc === "private") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end("<html><title>Sign in - Google Accounts</title></html>");
    }
    res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.end(doc);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  previous = process.env.GOOGLE_DOCS_BASE_URL;
  process.env.GOOGLE_DOCS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = service();
  for (const [key, id] of Object.entries(TEMPLATE_IDS)) {
    const { error } = await admin
      .from("work_stages")
      .update({ materials: { template_url: `https://docs.google.com/document/d/${id}/edit`, instructions_url: "https://docs.google.com/document/d/InstructionsForIntegrationTests1/edit" } })
      .eq("key", key);
    if (error) throw error;
  }
}

export async function stopGoogleDocs(): Promise<void> {
  if (previous === undefined) delete process.env.GOOGLE_DOCS_BASE_URL;
  else process.env.GOOGLE_DOCS_BASE_URL = previous;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
}

/** Registers a doc and returns its Google Docs link. */
export function gdoc(doc: Buffer | "private"): string {
  const id = `d${randomUUID().replace(/-/g, "")}`;
  docs.set(id, doc);
  return `https://docs.google.com/document/d/${id}/edit`;
}

/** An untouched copy of our real template (assessment-kits/ba-docs). */
export function templateCopy(stage: "ba_part1" | "ba_part2"): Buffer {
  return fs.readFileSync(path.join(process.cwd(), "assessment-kits/ba-docs", stage === "ba_part1" ? "BA1-answer-template.docx" : "BA2-handoff-template.docx"));
}
