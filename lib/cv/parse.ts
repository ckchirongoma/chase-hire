import { serverEnv } from "@/lib/config";
import { chatJson } from "@/lib/ai/openrouter";
import { loadPrompt } from "@/lib/prompts";
import { sanitise, wrapUntrusted, type SanitiseFlag } from "@/lib/sanitise";
import { ParsedCv } from "./schema";

export interface ParseCvInput {
  /** Text from extractText(). May be "" for a scanned PDF. */
  text: string;
  /** The original PDF, base64-encoded, used only when there is no text layer. */
  pdfBase64?: string;
  fileName?: string;
}

export interface ParseCvResult {
  parsed: ParsedCv;
  model: string;
  promptVersion: string;
  /** Sanitiser signals (zero_width, html_comment, prompt_injection). Logged, never decisive. */
  injectionFlags: SanitiseFlag[];
}

const PROMPT_KEY = "cv-parser";
const PROMPT_VERSION = 1;

/**
 * Parses a CV into structured JSON (cv-parser.v1).
 * Text path: sanitised text wrapped in <cv> tags, OPENROUTER_MODEL_CV_PARSE.
 * Scanned-PDF path (no text): the PDF is sent as a file part to OPENROUTER_MODEL_CV_VISION.
 */
export async function parseCv(input: ParseCvInput): Promise<ParseCvResult> {
  const env = serverEnv();
  const { system, promptVersion } = loadPrompt(PROMPT_KEY, PROMPT_VERSION);
  const { text, flags } = sanitise(input.text ?? "");

  if (text) {
    const res = await chatJson({
      model: env.OPENROUTER_MODEL_CV_PARSE,
      system,
      user: wrapUntrusted("cv", text),
      schema: ParsedCv,
      promptVersion,
      temperature: 0,
    });
    return { parsed: res.data, model: res.model, promptVersion: res.promptVersion, injectionFlags: flags };
  }

  if (input.pdfBase64) {
    const res = await chatJson({
      model: env.OPENROUTER_MODEL_CV_VISION,
      system,
      user: "Extract the CV in the attached PDF.",
      schema: ParsedCv,
      promptVersion,
      temperature: 0,
      files: [{ filename: input.fileName || "cv.pdf", mime: "application/pdf", base64: input.pdfBase64 }],
    });
    // The text sanitiser cannot see inside a scanned PDF, so there are no flags on this path.
    return { parsed: res.data, model: res.model, promptVersion: res.promptVersion, injectionFlags: [] };
  }

  throw new Error("parseCv: the CV has no extractable text and no PDF was supplied for the vision fallback");
}
