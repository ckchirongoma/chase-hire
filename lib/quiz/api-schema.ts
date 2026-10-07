import { z } from "zod";

/** Route param for /api/quiz/[role]/*. */
export const RoleSlug = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** POST /api/quiz/[role]/next: answer (or skip) the current item. */
export const QuizAnswerBody = z.object({
  attemptId: z.uuid(),
  position: z.number().int().min(1).max(15),
  // 0-based option indexes. null or [] = skip. Duplicates are collapsed server-side.
  answer: z.array(z.number().int().min(0).max(4)).max(5).nullable(),
});
