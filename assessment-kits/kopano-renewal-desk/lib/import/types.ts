import type { SupabaseClient } from "@supabase/supabase-js";

export type Db = SupabaseClient;

export interface QuarantineRow {
  row_number: number;
  reason: string;
  detail: string;
  raw: Record<string, string | number | boolean | null>;
}

export interface ImportResult {
  runId: string;
  kind: "base" | "contacts" | "optouts";
  fileName: string;
  counts: Record<string, unknown>;
  quarantine: QuarantineRow[];
}

/** The database refused the import (it rolled back: nothing was written). */
export class ImportApplyError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ImportApplyError";
  }
}

export async function sha256Hex(buffer: ArrayBuffer | Buffer): Promise<string> {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
