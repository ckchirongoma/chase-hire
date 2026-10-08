/**
 * Generates the synthetic assessment datasets (docs/11).
 *
 *   npx tsx scripts/synth/generate.ts --version v1 --seed 20261007 [--out scripts/synth/out] \
 *     [--starter-repo-url https://github.com/<owner>/<repo>]
 *
 * The SWE Test 1 README links the starter repo: pass --starter-repo-url (or set STARTER_REPO_URL).
 * Without it the README keeps the STARTER_REPO_URL placeholder, and upload.ts refuses to upload
 * it until the link is supplied (there or at upload time).
 *
 * Writes scripts/synth/out/<version>/bundle_{a,b,c,d}/{candidate,internal}/ plus manifest.json.
 * Deterministic: the same version + seed gives the same answer keys. Rotate the seed (and bump
 * the version) every cohort, then upload with scripts/synth/upload.ts and point
 * work_stages.dataset_bundle at "<version>/bundle_x".
 */
import path from "node:path";
import { buildBundles, unresolvedPlaceholders, writeBundles } from "../../lib/synth";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const version = arg("version", "v1");
  const seed = Number(arg("seed", "20261007"));
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  const out = path.resolve(arg("out", path.join("scripts", "synth", "out")));
  const started = Date.now();
  const starterRepoUrl = arg("starter-repo-url", process.env.STARTER_REPO_URL ?? "") || null;
  const files = await buildBundles({ version, seed, starterRepoUrl });
  const manifest = writeBundles(out, version, seed, files);
  for (const f of manifest.files) console.log(`${String(f.bytes).padStart(9)}  ${version}/${f.path}`);
  console.log(`\n${manifest.files.length} files in ${path.join(out, version)} (seed ${seed}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  for (const u of unresolvedPlaceholders(files)) {
    console.warn(`WARNING: ${version}/${u.path} still holds ${u.placeholders.join(", ")}. upload.ts refuses it until you pass --starter-repo-url (here or to upload.ts).`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
