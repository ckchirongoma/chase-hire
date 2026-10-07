import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLUEPRINT, type QuizRole } from "@/lib/quiz/blueprint";
import type { BankItem } from "@/lib/quiz/assemble";

export const SEED_SQL_PATH = fileURLToPath(
  new URL("../../../supabase/migrations/20261007000010_quiz_bank_seed.sql", import.meta.url),
);

export function readSeedSql(): string {
  return readFileSync(SEED_SQL_PATH, "utf8");
}

const ROW = new RegExp(
  String.raw`\('(software-engineer|business-analyst)',\s*'([a-z_]+)',\s*(true|false),\s*array\[([\d,\s]+)\],\s*` +
    String.raw`\$q\$([\s\S]*?)\$q\$,\s*jsonb_build_array\(((?:\s*\$q\$[\s\S]*?\$q\$\s*,?)+)\)\)`,
  "g",
);

/** Parses the quiz_seed VALUES rows out of the migration file. */
export function parseSeedItems(sql = readSeedSql()): BankItem[] {
  const items: BankItem[] = [];
  for (const m of sql.matchAll(ROW)) {
    const options = [...m[6]!.matchAll(/\$q\$([\s\S]*?)\$q\$/g)].map((o) => o[1]!);
    items.push({
      id: `seed-${String(items.length).padStart(4, "0")}`,
      role_slug: m[1]!,
      topic: m[2]!,
      multi: m[3] === "true",
      answer_key: m[4]!.split(",").map((s) => Number(s.trim())),
      stem: m[5]!,
      options,
    });
  }
  return items;
}

/** A synthetic bank: `perTopic` items for each topic of the role, every 4th one "select all". */
export function syntheticBank(role: QuizRole, perTopic = 6): BankItem[] {
  const out: BankItem[] = [];
  for (const { topic } of BLUEPRINT[role]) {
    for (let i = 0; i < perTopic; i++) {
      const multi = i % 4 === 3;
      const n = i % 2 === 0 ? 4 : 5;
      const options = Array.from({ length: n }, (_, k) => `${topic} q${i} option ${k}`);
      out.push({
        id: `${role}-${topic}-${i}`,
        role_slug: role,
        topic,
        stem: `${topic} question ${i}?`,
        options,
        answer_key: multi ? [0, n - 2] : [i % n],
        multi,
      });
    }
  }
  return out;
}
