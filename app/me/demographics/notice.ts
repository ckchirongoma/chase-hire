/**
 * The separate, voluntary consent for optional demographics (docs/12 §1 "Special personal
 * information", docs/09 §9). Race, gender and disability are collected only here, never in the
 * main flow. Changing the text means bumping DEMOGRAPHICS_NOTICE_VERSION; each saved answer
 * records the version the candidate agreed to.
 */
export const DEMOGRAPHICS_NOTICE_VERSION = "2026-10-08.v1-draft";

export const DEMOGRAPHICS_NOTICE: { title: string; body: string }[] = [
  {
    title: "Why we ask",
    body: "Employment equity law expects our assessments to be fair to every group. Once a hiring round has at least 30 people in a group, we compare how often each group moves forward at each stage. If one group does noticeably worse at a stage, we review that stage's questions and marking guides before the next round.",
  },
  {
    title: "It is optional",
    body: "You don't have to answer, and you can choose \"Prefer not to say\" for any question. Leaving this page empty has no effect on your application.",
  },
  {
    title: "Never used to assess you",
    body: "Your answers are never shown to the people or the AI that mark your work or interview you, and they are never used in any decision about you. Our team sees only totals for groups of 30 or more, never your answers.",
  },
  {
    title: "Kept apart",
    body: "Your answers are stored separately from your assessment results, and only you can see them. They are deleted with the rest of your information under our retention policy.",
  },
  {
    title: "Change or delete them any time",
    body: "Come back to this page to change your answers or delete them completely.",
  },
];

export const POPULATION_GROUPS = [
  { value: "african", label: "African" },
  { value: "coloured", label: "Coloured" },
  { value: "indian", label: "Indian" },
  { value: "white", label: "White" },
  { value: "other", label: "Other" },
  { value: "prefer_not", label: "Prefer not to say" },
] as const;

export const GENDERS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "non_binary", label: "Non-binary" },
  { value: "prefer_not", label: "Prefer not to say" },
] as const;

export const DISABILITY = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "prefer_not", label: "Prefer not to say" },
] as const;
