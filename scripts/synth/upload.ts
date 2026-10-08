/**
 * Uploads a generated dataset version to the private `datasets` bucket (upsert).
 *
 *   npx tsx --env-file=.env.local scripts/synth/upload.ts --version v1 [--dir scripts/synth/out] [--dry-run] \
 *     [--starter-repo-url https://github.com/<owner>/<repo>]
 *
 * Candidate files must not carry a generator placeholder (STARTER_REPO_URL, ...): the upload
 * fills STARTER_REPO_URL from --starter-repo-url (or the STARTER_REPO_URL env var) and refuses
 * to upload anything while a placeholder is still unresolved.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (service role: server-side only).
 * Objects land at datasets/<version>/bundle_x/{candidate,internal}/<file>. Candidates only ever
 * get signed URLs for candidate/ after pressing Start; internal/ (answer keys, the held-back
 * month-2 files) is read by graders and the SWE harness only.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { fillStarterRepoUrl, placeholdersIn, validStarterRepoUrl } from "../../lib/synth/placeholders";

const BUCKET = "datasets";
const TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".json": "application/json",
  ".csv": "text/csv",
  ".sql": "application/sql",
  ".md": "text/markdown",
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function main() {
  const version = arg("version", "v1");
  if (!/^v\d+$/.test(version)) throw new Error(`--version must look like v1, got "${version}"`);
  const root = path.resolve(arg("dir", path.join("scripts", "synth", "out")), version);
  if (!fs.existsSync(root)) throw new Error(`${root} not found: run scripts/synth/generate.ts --version ${version} first`);
  const dryRun = process.argv.includes("--dry-run");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!dryRun && (!url || !key)) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  const supabase = dryRun ? null : createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });

  const files = walk(root)
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((f) => /^bundle_[a-d]\/(candidate|internal)\//.test(f) || f === "manifest.json")
    .sort();
  // Resolve candidate-file placeholders before anything is uploaded; refuse if any remain.
  const starterRepo = arg("starter-repo-url", process.env.STARTER_REPO_URL ?? "");
  if (starterRepo) validStarterRepoUrl(starterRepo);
  const bodies = new Map<string, Buffer>();
  const unresolved: string[] = [];
  for (const rel of files) {
    let body = fs.readFileSync(path.join(root, rel));
    if (/\/candidate\//.test(rel) && /\.(md|txt|csv|sql|json)$/.test(rel)) {
      let text = body.toString("utf8");
      if (starterRepo && placeholdersIn(text).length) {
        text = fillStarterRepoUrl(text, starterRepo);
        body = Buffer.from(text);
      }
      const left = placeholdersIn(text);
      if (left.length) unresolved.push(`${rel} (${left.join(", ")})`);
    }
    bodies.set(rel, body);
  }
  if (unresolved.length) {
    throw new Error(`refusing to upload: unresolved placeholders in candidate files: ${unresolved.join("; ")}. Pass --starter-repo-url https://github.com/<owner>/<repo>.`);
  }

  let bytes = 0;
  for (const rel of files) {
    const body = bodies.get(rel)!;
    const objectPath = `${version}/${rel}`;
    const contentType = TYPES[path.extname(rel)] ?? "application/octet-stream";
    if (supabase) {
      const { error } = await supabase.storage.from(BUCKET).upload(objectPath, body, { upsert: true, contentType });
      if (error) throw new Error(`${objectPath}: ${error.message}`);
    }
    bytes += body.length;
    console.log(`${dryRun ? "would upload" : "uploaded"}  ${String(body.length).padStart(9)}  ${BUCKET}/${objectPath}  (${contentType})`);
  }
  console.log(`\n${files.length} files, ${(bytes / 1024).toFixed(0)} KiB ${dryRun ? "(dry run)" : `to ${BUCKET}/${version}/`}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
