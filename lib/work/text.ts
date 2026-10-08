/**
 * Text that Postgres (text and jsonb columns, through PostgREST's JSON body) can always store:
 * no NUL or other C0 control characters except \t and \n (\r\n and \r become \n), no DEL, and
 * no unpaired UTF-16 surrogates (replaced with U+FFFD). Zero-width and other invisible
 * characters are kept: the raw extracted text is evidence, and sanitise() flags them.
 */

// C0 controls except \t (09) and \n (0A); \r is normalised first. Plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function storableText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(LONE_SURROGATE, "\uFFFD");
}
