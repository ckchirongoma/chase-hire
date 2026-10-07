/**
 * POPIA s18 notice shown on /consent and /privacy. DRAFT v1: to be reviewed by an
 * employment/privacy lawyer before launch (docs/12-compliance.md). Changing the text
 * means bumping NOTICE_VERSION so we know which version each candidate accepted.
 */
export const NOTICE_VERSION = "2026-10-07.v1-draft";

export const NOTICE_SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Who we are",
    body: [
      "Chase Agents is the responsible party for the personal information you give us during this hiring process. Our information officer is the head of the business. You can contact us about your information at any time through the contact details on our website.",
    ],
  },
  {
    title: "What we collect",
    body: [
      "Your identity and contact details, your CV, your answers to our assessments, transcripts of AI-run chats, and interaction signals such as when you leave a timed assessment's browser tab or try to paste text.",
      "We do not ask for your race, religion, health, age or marital status, and our CV parser is told not to extract them.",
    ],
  },
  {
    title: "Why we collect it",
    body: [
      "To assess your suitability for the role you apply for. Our lawful basis is taking steps towards an employment contract at your request, with your consent as a backup.",
    ],
  },
  {
    title: "How we use AI, and who decides",
    body: [
      "We use AI models to read your CV, run a structured screening interview and give advisory scores on your work. A person at Chase Agents makes every decision to advance or reject a candidate. No decision is made by automated processing alone.",
      "How we score you: a 15-minute reasoning assessment (10% of the pre-interview score, used as a minimum hurdle, never as an automatic rejection), an AI screening interview (15%), a role quiz (15%) and two work assessments (60% together). The live stage with our team decides the outcome.",
    ],
  },
  {
    title: "Processing outside South Africa",
    body: [
      "Our database and file storage (Supabase), our web hosting (Vercel), and the AI model providers we reach through OpenRouter process data outside South Africa, mainly in the European Union and the United States. We use providers with contractual safeguards and, where available, settings that stop the AI providers from keeping your data.",
    ],
  },
  {
    title: "Duplicate accounts",
    body: [
      "We compare CVs and contact details across accounts to spot the same person applying more than once (for example, to retake the reasoning assessment). A match is only a flag for a person to review. It never removes you automatically.",
    ],
  },
  {
    title: "How long we keep it",
    body: [
      "If you are not appointed, we delete or de-identify your information 6 months after the hiring round closes. If you opt into our talent pool, we keep it for 12 months so we can contact you about future roles. We keep anonymised statistics about our assessments to check they are fair.",
    ],
  },
  {
    title: "Your rights",
    body: [
      "You can ask to see or correct your information, object to processing, or ask a person to review any score you receive. Use the \"Request a review\" button on your results page. You may also complain to the Information Regulator.",
    ],
  },
  {
    title: "Your work",
    body: [
      "You keep the copyright in everything you submit. We will not use your submissions commercially. All assessment data you work with is synthetic.",
    ],
  },
];
