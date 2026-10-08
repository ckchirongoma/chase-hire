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
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer).digest("hex");
}
