/**
 * Sanitiser for hostile input (CLAUDE.md hard rule 5).
 *
 * Used on CV text now and on grader submissions later. It strips invisible characters,
 * HTML/XML comments, tags and control characters, and raises *signals* (flag codes)
 * when it finds hidden content or instruction-like text. Flags are logged for an admin;
 * they never penalise a candidate on their own.
 */

export type SanitiseFlag = "zero_width" | "html_comment" | "prompt_injection";

export interface SanitiseResult {
  text: string;
  flags: SanitiseFlag[];
}

/** Zero-width / invisible formatting characters (incl. bidi overrides) that are removed AND flagged. */
const INVISIBLE_FLAGGED = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Soft hyphens are common in legitimate PDF/Word exports: removed silently, not flagged. */
const SOFT_HYPHEN = /\u00AD/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
/** HTML/XML comments; an unterminated comment runs to the end of the text. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
/** script/style blocks are hidden content: drop them with their contents. */
const SCRIPT_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAG = /<\/?(?:br|p|div|li|tr|h[1-6]|ul|ol|table|section|article|header|footer)\b[^<>]*>/gi;
const ANY_TAG = /<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g;
/** C0 controls except \t (09) and \n (0A), plus DEL and C1 controls. \r is normalised first. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Instruction-like text aimed at an AI reader. Kept deliberately narrow so normal CV prose
 * ("gave instructions to a team of 5", "designed system prompts") does not trip it.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|of|previous|prior|above|earlier|preceding|your|my|other|these|those)\s+)+(?:instructions?|prompts?|directions|directives|guidelines|rules)\b/i,
  /\bdisregard\s+(?:\w+\s+){0,3}?instructions?\b/i,
  /\byou\s+are\s+now\s+(?:an?|the|my)\b/i,
  /\byou\s+are\s+(?:an?|the)\s+(?:[\w-]+\s+)?(?:ai\s+(?:assistant|model|grader|evaluator|recruiter|reviewer|judge)|assistant|grader|evaluator|language\s+model|llm|chatbot)\b/i,
  /\b(?:reveal|print|repeat|show|output|ignore|disregard|forget|override|overriding|your)\s+(?:the\s+|your\s+|this\s+)?system\s+prompt\b/i,
  /^\s*(?:#+\s*|\[\s*)?system\s+prompt\s*[:\]]/im,
  // Imperative only: at a line/sentence start or after "please" ("Managers rate me as..." is fine).
  /(?:^|[.!?:;]\s*|\bplease\s+)(?:score|rate|grade|rank)\s+(?:me|this\s+(?:candidate|cv|resume|résumé|submission|answer|application|response|person|applicant))\b/im,
  /\bgive\s+(?:this\s+\w+|this|me|them|the\s+candidate)\s+(?:a\s+|an\s+|the\s+)?(?:(?:5|five|10|ten|100)\b(?!\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?)\b)|full\s+marks|top\s+marks|perfect\s+score|(?:highest|maximum|max|top)\s+(?:score|marks|rating|grade))/i,
  /<\s*\/?\s*(?:system|assistant)\s*>/i,
  /\[\/?(?:system|assistant|INST)\]/i,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\bas\s+an\s+ai\s+language\s+model\b/i,
  /\bnew\s+instructions\s*:/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export function sanitise(input: string): SanitiseResult {
  const flags = new Set<SanitiseFlag>();
  let text = input ?? "";

  // A single leading BOM is an encoding artefact, not hidden content.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  text = text.replace(/\r\n?/g, "\n").replace(LINE_SEPARATORS, "\n");

  const withoutInvisible = text.replace(INVISIBLE_FLAGGED, "");
  if (withoutInvisible !== text) flags.add("zero_width");
  text = withoutInvisible.replace(SOFT_HYPHEN, "");

  // Detect before stripping comments/tags so hidden instructions are still seen.
  if (detectInjection(text)) flags.add("prompt_injection");

  const withoutComments = text.replace(HTML_COMMENT, "");
  if (withoutComments !== text) flags.add("html_comment");
  text = withoutComments;

  text = text
    .replace(SCRIPT_STYLE, "")
    .replace(BLOCK_TAG, "\n")
    .replace(ANY_TAG, "")
    .replace(CONTROL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const order: SanitiseFlag[] = ["zero_width", "html_comment", "prompt_injection"];
  return { text, flags: order.filter((f) => flags.has(f)) };
}

/**
 * Wraps untrusted text in `<tag>…</tag>` delimiters. Any opening or closing `tag` inside the
 * text is neutralised (its "<" escaped) so the content cannot break out of the wrapper.
 */
export function wrapUntrusted(tag: string, text: string): string {
  if (!/^[a-z][a-z0-9_-]*$/i.test(tag)) throw new Error(`wrapUntrusted: invalid tag "${tag}"`);
  // Escape the "<" of any opening/closing occurrence of the tag, with or without a ">".
  const tagRe = new RegExp(`<(?=\\s*/?\\s*${tag}\\b)`, "gi");
  const safe = text.replace(tagRe, "&lt;");
  return `<${tag}>\n${safe}\n</${tag}>`;
}
