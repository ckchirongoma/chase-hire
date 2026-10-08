import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findBanned, realFigureCollisions } from "./banned";
import { buildBundleA, BUNDLE_A_FILE } from "./bundle-a";
import { buildBundleB, toCsv } from "./bundle-b";
import { buildBundleC, C_FILES } from "./bundle-c";
import { DATA_ROOM_MD } from "./bundle-d";
import { fillStarterRepoUrl, placeholdersIn } from "./placeholders";
import { readWorkbook, workbookBuffer } from "./xlsx";

/**
 * Builds every bundle for one dataset version (docs/11) in memory, checks nothing real leaked,
 * and writes them as <outDir>/<version>/bundle_{a,b,c,d}/{candidate,internal}/...
 * candidate/ is downloadable by the candidate after Start; internal/ never is.
 */

export interface BuiltFile {
  /** Relative to the version folder, e.g. "bundle_a/candidate/kopano_vsam_extract.xlsx". */
  path: string;
  content: Buffer;
}

const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const text = (s: string) => Buffer.from(s);

export interface BuildOptions {
  version: string;
  seed: number;
  /** The SWE Test 1 starter repo (https://github.com/<owner>/<repo>). Without it the bundle C README keeps STARTER_REPO_URL. */
  starterRepoUrl?: string | null;
}

export async function buildBundles(opts: BuildOptions): Promise<BuiltFile[]> {
  const { version, seed } = opts;
  if (!/^v\d+$/.test(version)) throw new Error(`version must look like v1, got "${version}"`);
  const a = buildBundleA(seed, version);
  const b = buildBundleB(a, seed, version);
  const c = buildBundleC(seed, version);

  const files: BuiltFile[] = [
    { path: `bundle_a/candidate/${BUNDLE_A_FILE}`, content: await workbookBuffer(a.workbook) },
    { path: "bundle_a/internal/answer_key.json", content: json(a.answerKey) },
    ...b.tables.map((t) => ({ path: `bundle_b/candidate/${t.name}.csv`, content: text(toCsv(t)) })),
    { path: "bundle_b/candidate/seed.sql", content: text(b.seedSql) },
    { path: "bundle_b/candidate/solution_brief.md", content: text(b.solutionBrief) },
    { path: "bundle_b/candidate/README.md", content: text(b.readme) },
    { path: "bundle_b/internal/meta.json", content: json(b.meta) },
    { path: `bundle_c/candidate/${C_FILES.month1}`, content: await workbookBuffer(c.month1) },
    { path: `bundle_c/candidate/${C_FILES.contacts}`, content: await workbookBuffer(c.contacts) },
    { path: `bundle_c/candidate/${C_FILES.optouts}`, content: await workbookBuffer(c.optouts) },
    { path: "bundle_c/candidate/README.md", content: text(opts.starterRepoUrl ? fillStarterRepoUrl(c.readme, opts.starterRepoUrl) : c.readme) },
    { path: `bundle_c/candidate/${C_FILES.handoff}`, content: text(c.handoff) },
    { path: `bundle_c/internal/${C_FILES.month2}`, content: await workbookBuffer(c.month2) },
    { path: `bundle_c/internal/${C_FILES.drift}`, content: await workbookBuffer(c.drift) },
    { path: `bundle_c/internal/${C_FILES.expected}`, content: json(c.expected) },
    { path: "bundle_d/candidate/data_room.md", content: text(DATA_ROOM_MD) },
  ];

  const collisions = realFigureCollisions(a.answerKey.figures);
  if (collisions.length) throw new Error(`bundle A reproduces real figures: ${collisions.join(", ")}`);
  const leaks = await scanForBanned(files);
  if (leaks.length) throw new Error(`banned values in generated files: ${leaks.map((l) => `${l.path}: ${l.hits.join(", ")}`).join("; ")}`);
  return files;
}

/** Every string a file exposes (xlsx cells and sheet names, or the raw text). */
export async function fileText(f: BuiltFile): Promise<string> {
  if (!f.path.endsWith(".xlsx")) return f.content.toString("utf8");
  const sheets = await readWorkbook(f.content);
  const parts: string[] = [];
  for (const s of sheets.values()) {
    parts.push(s.name, ...s.headers.map((h) => h ?? ""));
    for (const r of s.rows) for (const c of r.cells) if (c !== null && !(c instanceof Date)) parts.push(typeof c === "object" ? JSON.stringify(c) : String(c));
  }
  return parts.join("\n");
}

/** Candidate files that still hold a placeholder (STARTER_REPO_URL, ...): they must not be uploaded. */
export function unresolvedPlaceholders(files: readonly BuiltFile[]): { path: string; placeholders: string[] }[] {
  return files
    .filter((f) => f.path.includes("/candidate/") && /\.(md|txt|csv|sql|json)$/.test(f.path))
    .map((f) => ({ path: f.path, placeholders: placeholdersIn(f.content.toString("utf8")) }))
    .filter((f) => f.placeholders.length > 0);
}

export async function scanForBanned(files: BuiltFile[]): Promise<{ path: string; hits: string[] }[]> {
  const out: { path: string; hits: string[] }[] = [];
  for (const f of files) {
    const hits = findBanned(await fileText(f));
    if (hits.length) out.push({ path: f.path, hits });
  }
  return out;
}

export interface Manifest {
  version: string;
  seed: number;
  files: { path: string; bytes: number; sha256: string }[];
}

export function writeBundles(outDir: string, version: string, seed: number, files: BuiltFile[]): Manifest {
  const root = path.join(outDir, version);
  fs.rmSync(root, { recursive: true, force: true });
  for (const f of files) {
    const full = path.join(root, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content);
  }
  const manifest: Manifest = {
    version,
    seed,
    files: files.map((f) => ({ path: f.path, bytes: f.content.length, sha256: createHash("sha256").update(f.content).digest("hex") })),
  };
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
