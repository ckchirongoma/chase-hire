import { z } from "zod";
import { isQuizRole, topicsFor } from "./blueprint";

// Options are shuffled per candidate, so options that refer to other options are not allowed.
const POSITIONAL = /\b(all|none|both|neither) of the (above|below)\b|^(both|neither) [a-e]\b/i;

/**
 * Admin "add item" form. Options come one per line; the correct answers are typed as
 * 1-based numbers ("2" or "1, 3"). The result matches the quiz_items columns.
 */
export const NewQuizItem = z
  .object({
    role_topic: z.string().regex(/^[a-z0-9-]+:[a-z_]+$/, "Choose a role and topic"),
    stem: z.string().trim().min(10, "The question needs at least 10 characters").max(1000),
    options: z.string(),
    correct: z.string().trim().min(1, "Give the correct option number(s)"),
    multi: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  })
  .transform((v, ctx) => {
    const [role_slug = "", topic = ""] = v.role_topic.split(":");
    if (!isQuizRole(role_slug) || !topicsFor(role_slug).includes(topic)) {
      ctx.addIssue({ code: "custom", message: "Unknown role or topic" });
      return z.NEVER;
    }
    const options = v.options
      .split(/\r?\n/)
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length < 4 || options.length > 5) {
      ctx.addIssue({ code: "custom", message: "Give 4 or 5 options, one per line" });
      return z.NEVER;
    }
    if (options.some((o) => o.length > 300)) {
      ctx.addIssue({ code: "custom", message: "Keep each option under 300 characters" });
      return z.NEVER;
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      ctx.addIssue({ code: "custom", message: "Options must be different from each other" });
      return z.NEVER;
    }
    if (options.some((o) => POSITIONAL.test(o))) {
      ctx.addIssue({ code: "custom", message: "Options are shuffled, so don't use 'all/none of the above' or 'both A and B'" });
      return z.NEVER;
    }
    const parts = v.correct.split(/[\s,]+/).filter(Boolean);
    const numbers = parts.map(Number);
    if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > options.length)) {
      ctx.addIssue({ code: "custom", message: `Correct answers must be option numbers from 1 to ${options.length}` });
      return z.NEVER;
    }
    const answer_key = [...new Set(numbers.map((n) => n - 1))].sort((a, b) => a - b);
    if (!v.multi && answer_key.length !== 1) {
      ctx.addIssue({ code: "custom", message: "A single-answer item has exactly one correct option; tick 'select all that apply' for more" });
      return z.NEVER;
    }
    if (answer_key.length === options.length) {
      ctx.addIssue({ code: "custom", message: "At least one option must be wrong" });
      return z.NEVER;
    }
    return { role_slug, topic, stem: v.stem, options, answer_key, multi: v.multi };
  });

export type NewQuizItemInput = z.output<typeof NewQuizItem>;
