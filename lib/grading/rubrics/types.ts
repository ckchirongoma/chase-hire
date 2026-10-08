import type { RubricCriterion } from "../schema";

/** A rubric as seeded into public.rubrics (criteria + reference JSON). */
export interface RubricDefinition {
  key: string;
  version: number;
  title: string;
  criteria: RubricCriterion[];
  reference: Record<string, unknown>;
}
