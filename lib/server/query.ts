import "server-only";

const PAGE = 1000;

/** Reads every row of a query, a page at a time (PostgREST caps a response at 1000 rows). */
export async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * `.in()` on large id lists in chunks: filters travel in the URL, and the API gateway refuses
 * long ones (50 UUIDs ≈ 1.9 KB, twice that for the dedupe or-filter).
 */
const CHUNK = 50;
export async function inChunks<T>(ids: readonly string[], run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await run(ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}
