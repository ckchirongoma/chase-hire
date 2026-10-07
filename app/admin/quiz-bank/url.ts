/** /admin/quiz-bank URL with the role tab, optional topic filter and a flash message. */
export function bankUrl(role: string, extra: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams({ role });
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return `/admin/quiz-bank?${q.toString()}`;
}
