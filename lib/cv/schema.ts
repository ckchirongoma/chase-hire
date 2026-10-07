import { z } from "zod";

/**
 * Zod schema for cv-parser output (docs/10-prompts.md#cv-parser.v1).
 *
 * Lenient on purpose so real model output validates: missing/empty strings become null,
 * numbers become strings (e.g. year: 2019), null/missing lists become [], blank list items are
 * dropped, unknown keys are stripped, and claim ids are made unique (c1, c2, …).
 */

const optStr = z
  .preprocess(
    (v) => (typeof v === "number" ? String(v) : v),
    z.string().nullish(),
  )
  .transform((v) => {
    const t = v?.trim();
    return t ? t : null;
  });

const stringList = z
  .array(optStr)
  .nullish()
  .transform((v) => (v ?? []).filter((s): s is string => s !== null));

function list<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullish()
    .transform((v): z.output<T>[] => v ?? []);
}

const Identity = z.object({
  full_name: optStr,
  email: optStr,
  phone: optStr,
  linkedin: optStr,
  github: optStr,
  city: optStr,
});

const Education = z.object({
  institution: optStr,
  qualification: optStr,
  year: optStr,
});

const Claim = z.object({
  id: optStr,
  text: optStr,
  quantified: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean().nullish(),
  ),
  skills: stringList,
});

const Role = z.object({
  employer: optStr,
  title: optStr,
  start: optStr,
  end: optStr,
  claims: list(Claim),
});

export interface CvClaim {
  id: string;
  text: string;
  quantified: boolean;
  skills: string[];
}

export const ParsedCv = z
  .object({
    identity: z.preprocess((v) => v ?? {}, Identity),
    education: list(Education),
    roles: list(Role),
    skills: stringList,
    links: stringList,
    summary: optStr,
  })
  .transform((cv) => {
    // Claims with no text are dropped. The model's ids are kept where unique; missing or
    // duplicate ids get the next free "cN" that no other claim uses.
    const withText = cv.roles.map((role) =>
      role.claims.filter((c): c is typeof c & { text: string } => c.text !== null),
    );
    const reserved = new Set(withText.flat().flatMap((c) => (c.id ? [c.id] : [])));
    const used = new Set<string>();
    let next = 1;
    const freshId = () => {
      while (used.has(`c${next}`) || reserved.has(`c${next}`)) next++;
      return `c${next}`;
    };

    const roles = cv.roles.map((role, i) => ({
      ...role,
      claims: withText[i].map((c): CvClaim => {
        const id = c.id && !used.has(c.id) ? c.id : freshId();
        used.add(id);
        return { id, text: c.text, quantified: c.quantified ?? /\d/.test(c.text), skills: c.skills };
      }),
    }));
    return { ...cv, roles };
  });

export type ParsedCv = z.output<typeof ParsedCv>;
