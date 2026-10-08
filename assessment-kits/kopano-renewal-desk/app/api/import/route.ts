import { getCaller } from "@/lib/auth";
import { errorJson, json } from "@/lib/http";
import { importBaseFile } from "@/lib/import/base";
import { ImportStructureError } from "@/lib/import/columns";
import { importContactsFile } from "@/lib/import/contacts";
import { importOptoutsFile } from "@/lib/import/optouts";
import { ImportApplyError, sha256Hex, type Db, type ImportResult } from "@/lib/import/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const IMPORTERS: Record<string, (db: Db, name: string, buf: Buffer) => Promise<ImportResult>> = {
  base: importBaseFile,
  contacts: importContactsFile,
  optouts: importOptoutsFile,
};

/**
 * Manager uploads (multipart: `file`, optional `kind` = base | optouts | contacts). Each import
 * is all-or-nothing; a structure change or a database refusal returns 4xx naming the problem,
 * and the failed attempt is logged in import_runs.
 */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  if (!caller.isManager) return errorJson(403, "Only a manager can import files.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorJson(400, "Upload the file as multipart/form-data in a field called `file`.");
  }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "base");
  if (!(file instanceof File)) return errorJson(400, "Upload the file in a field called `file`.");
  if (!IMPORTERS[kind]) return errorJson(400, "kind must be base, optouts or contacts.");
  if (file.size > MAX_BYTES) return errorJson(413, "The file is larger than 10 MB.");
  if (!/\.xlsx$/i.test(file.name)) return errorJson(415, "Upload an Excel workbook (.xlsx).");

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await IMPORTERS[kind](caller.db, file.name, buffer);
    return json(result);
  } catch (err) {
    const known = err instanceof ImportStructureError || err instanceof ImportApplyError;
    const message = known ? (err as Error).message : "The import failed unexpectedly. Nothing was imported.";
    if (!known) console.error("import failed", err);
    await caller.db.rpc("record_import_failure", { p_kind: kind, p_file_name: file.name, p_file_sha256: await sha256Hex(buffer), p_error: message });
    return errorJson(known ? 422 : 500, message, err instanceof ImportStructureError ? { missing: err.missing, unexpected: err.unexpected } : undefined);
  }
}
