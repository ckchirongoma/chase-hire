/**
 * Harness calibration (docs/07 "Building the starter", step 4; assessment-kits/README.md §5):
 * runs the deployed-URL checks (U1–U8) and, with --import, the month-2 import and data checks
 * (M1–M7, D-a..D-c) against OUR reference or starter deployment, adds the repo checks from
 * repo-checks.ts's results.json, and says whether the harness and the app agree:
 * the reference passes everything; the starter fails every check docs/16 maps to a fault.
 *
 *   npx tsx --conditions=react-server scripts/verify-swe1/calibrate.ts --expect reference|starter \
 *     --url http://127.0.0.1:3100 --logins logins.txt --bundle scripts/synth/out/v1/bundle_c \
 *     [--repo-results results.json] [--import] [--burst 100] [--out calibration.json]
 *
 * --logins: the three test_logins lines the seed prints (docs/16 format). --bundle: a generated
 * bundle_c folder (candidate/optouts_legal.xlsx, internal/*). --import uploads the held-back
 * month-2 files to the deployment and changes its data: reset and re-seed it afterwards.
 * Nothing is written to the platform database. Exit code 1 when the harness and the app disagree.
 *
 * Only for our own deployments: private addresses (localhost) are allowed here, unlike the
 * admin panel's runs against candidates' URLs.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArtifact } from "../../lib/harness/artifact";
import { calibrate, type CalibrationTarget } from "../../lib/harness/calibration";
import type { CheckResult } from "../../lib/harness/checks";
import { HarnessExpected, optoutEntriesFromSheet } from "../../lib/harness/expected";
import { Budget, createHttp } from "../../lib/harness/http";
import { runImportChecks } from "../../lib/harness/import-checks";
import { parseTestLogins } from "../../lib/harness/logins";
import { runUrlChecks } from "../../lib/harness/url-checks";
import { readFirstSheet } from "../../lib/harness/xlsx-lite";

interface Args {
  expect: CalibrationTarget;
  url: string;
  logins: string;
  bundle: string;
  repoResults: string[];
  withImport: boolean;
  burst: number | undefined;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const die = (m: string): never => {
    console.error(`calibrate: ${m}`);
    process.exit(2);
  };
  const expect = get("expect");
  if (expect !== "reference" && expect !== "starter") die("--expect must be reference or starter");
  const url = get("url") ?? die("--url is required (the deployed app)");
  if (!/^https?:\/\//.test(url)) die("--url must start with http:// or https://");
  const repoResults = argv.flatMap((a, i) => (a === "--repo-results" && argv[i + 1] ? [argv[i + 1]] : []));
  const burst = get("burst");
  return {
    expect: expect as CalibrationTarget,
    url,
    logins: get("logins") ?? die("--logins is required (a file with the three test_logins lines)"),
    bundle: path.resolve(get("bundle") ?? die("--bundle is required (a generated bundle_c folder)")),
    repoResults,
    withImport: argv.includes("--import"),
    burst: burst ? Number(burst) : undefined,
    out: get("out") ?? null,
  };
}

const mark = (p: boolean | null | undefined) => (p === true ? "PASS" : p === false ? "FAIL" : p === null ? "----" : "    ");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logins = parseTestLogins(fs.readFileSync(args.logins, "utf8"));
  const expected = HarnessExpected.parse(JSON.parse(fs.readFileSync(path.join(args.bundle, "internal", "expected_month2.json"), "utf8")));
  const sheet = path.join(args.bundle, "candidate", "optouts_legal.xlsx");
  const optouts = fs.existsSync(sheet) ? (optoutEntriesFromSheet(readFirstSheet(fs.readFileSync(sheet)), expected) ?? []) : [];
  const overrides = { supabaseUrl: logins.supabaseUrl, anonKey: logins.publishableKey };
  const results: CheckResult[] = [];

  for (const file of args.repoResults) results.push(...(parseArtifact(fs.readFileSync(file, "utf8")).checks as CheckResult[]));

  const urlRun = await runUrlChecks({
    http: createHttp({ budget: new Budget(265_000), allowPrivate: true }),
    deployedUrl: args.url,
    logins,
    optouts,
    optoutSource: `bundle optouts_legal.xlsx (${optouts.length} names)`,
    overrides,
    burstSize: args.burst,
  });
  results.push(...urlRun.results);

  if (args.withImport) {
    console.log("Uploading the month-2 files to the deployment (this changes its data: reset and re-seed it afterwards).");
    const files = { month2: fs.readFileSync(path.join(args.bundle, "internal", "base_month2.xlsx")), drift: fs.readFileSync(path.join(args.bundle, "internal", "base_month2_drift.xlsx")) };
    const importRun = await runImportChecks({ http: createHttp({ budget: new Budget(270_000), allowPrivate: true }), deployedUrl: args.url, logins, expected, files, overrides });
    if (importRun.skipped.length) console.log(`Skipped (month 2 already imported: reset the deployment first): ${importRun.skipped.join(", ")}`);
    results.push(...importRun.results);
  }

  const verdict = calibrate(args.expect, results);
  const summaryOf = new Map(results.map((r) => [r.key, String(r.detail.summary)]));
  console.log(`\nCalibration against the ${args.expect} at ${args.url}\n`);
  for (const r of verdict.rows) {
    if (r.passed === undefined) continue;
    const faults = r.faults.length ? r.faults.join(",") : "-";
    console.log(`${r.ok ? "  " : "!!"} ${r.key.padEnd(4)} ${mark(r.passed)}  ${faults.padEnd(8)} ${r.note}: ${summaryOf.get(r.key)?.slice(0, 160) ?? ""}`);
  }
  if (verdict.notRun.length) console.log(`\nNot run: ${verdict.notRun.join(", ")}${args.withImport ? "" : " (M and D checks need --import)"}${args.repoResults.length ? "" : " (R checks need --repo-results from repo-checks.ts)"}`);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ target: args.expect, url: args.url, ran_at: new Date().toISOString(), verdict, results, context: urlRun.context }, null, 2));
  if (verdict.mismatches.length) {
    console.log(`\n${verdict.mismatches.length} mismatch(es): ${verdict.mismatches.map((m) => m.key).join(", ")}. The harness or the ${args.expect} needs fixing.`);
    process.exit(1);
  }
  console.log(`\nThe harness and the ${args.expect} agree.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
