/**
 * Resolves to { value: null, timedOut: true } if `p` takes longer than `ms`. A rejection is
 * treated as null (JEV and other best-effort helpers must never fail the caller).
 */
export async function withBudget<T>(p: Promise<T | null>, ms: number | undefined): Promise<{ value: T | null; timedOut: boolean }> {
  const safe = p.catch(() => null);
  if (ms === undefined || !Number.isFinite(ms)) return { value: await safe, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), Math.max(0, ms));
  });
  try {
    return await Promise.race([safe.then((value) => ({ value, timedOut: false })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
