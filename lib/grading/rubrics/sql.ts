import { WORK_RUBRICS, type RubricDefinition } from "./index";

/**
 * Renders the rubric seed block of migration 20261007000012 from WORK_RUBRICS. To print it:
 *   npx tsx -e 'import("./lib/grading/rubrics/sql.ts").then((m) => process.stdout.write(m.renderRubricInserts()))'
 * tests/unit/rubrics asserts the migration contains exactly this text.
 */

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function renderRubricInsert(r: RubricDefinition): string {
  const crit = `criteria_${r.key}`;
  const ref = `reference_${r.key}`;
  return [
    `insert into public.rubrics (key, version, title, criteria, reference, active) values (`,
    `  ${sqlText(r.key)}, ${r.version}, ${sqlText(r.title)},`,
    `  $${crit}$${JSON.stringify(r.criteria, null, 2)}$${crit}$::jsonb,`,
    `  $${ref}$${JSON.stringify(r.reference, null, 2)}$${ref}$::jsonb,`,
    `  true)`,
    `on conflict (key, version) do update`,
    `  set title = excluded.title, criteria = excluded.criteria, reference = excluded.reference;`,
  ].join("\n");
}

export function renderRubricInserts(): string {
  return `${WORK_RUBRICS.map(renderRubricInsert).join("\n\n")}\n`;
}
