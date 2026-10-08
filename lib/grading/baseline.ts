/**
 * The generic baseline (docs/09 §3, docs/10 generic-baseline.v1) is stored in
 * rubrics.generic_baseline as text with a small header, so the prompt version and model that
 * produced it travel with it (hard rule: prompt_version on every AI output).
 */

export interface BaselineMeta {
  prompt_version: string;
  model: string;
  generated_at: string;
}

export function formatBaseline(answer: string, meta: BaselineMeta): string {
  return `---\nprompt_version: ${meta.prompt_version}\nmodel: ${meta.model}\ngenerated_at: ${meta.generated_at}\n---\n${answer.trim()}\n`;
}

/** Splits a stored baseline into its answer and header (a header-less text is all answer). */
export function parseBaseline(stored: string | null | undefined): { answer: string; meta: Partial<BaselineMeta> } | null {
  if (!stored?.trim()) return null;
  const m = stored.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { answer: stored.trim(), meta: {} };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  const answer = m[2].trim();
  return answer ? { answer, meta } : null;
}
