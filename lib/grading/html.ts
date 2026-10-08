import { detectInjection, sanitise, type SanitiseFlag } from "@/lib/sanitise";

/**
 * MVP snapshot HTML → the text a visitor would see (hard rule 5: strip hidden text). Before the
 * sanitiser removes tags, comments, scripts and styles, elements a human never sees are dropped:
 * the `hidden` attribute, <template>, inline display:none / visibility:hidden / opacity:0 /
 * zero font size / off-screen positioning / text the same colour as its background, Tailwind's
 * `hidden` / `invisible` utilities (unless a responsive variant shows them), and classes or ids
 * that a <style> block hides. Hidden text is a signal (flag "hidden_text"), never a penalty.
 * aria-hidden content is dropped too (decorative, not read out), without a flag.
 */

export type SnapshotFlag = SanitiseFlag | "hidden_text";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?)(\/?)>/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

const HIDING_DECL = [
  /(?:^|;)\s*display\s*:\s*none\b/i,
  /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\b/i,
  /(?:^|;)\s*opacity\s*:\s*0*(?:\.0+)?\s*(?:!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*font-size\s*:\s*0(?:\.0+)?\s*(?:px|em|rem|pt|%)?\s*(?:!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*(?:text-indent|left|top|margin-left|margin-top)\s*:\s*-\s*\d{3,}(?:\.\d+)?\s*(?:px|em|rem|vw|vh)?/i,
  /(?:^|;)\s*color\s*:\s*transparent\b/i,
  /(?:^|;)\s*clip(?:-path)?\s*:\s*(?:rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)|inset\(\s*(?:50|100)%\s*\))/i,
];

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "transparent", red: "#ff0000", blue: "#0000ff", green: "#008000" };

/** Normalises a CSS colour to #rrggbb (or "transparent"); null when it cannot tell. */
export function normaliseColour(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/\s*!important$/, "");
  if (NAMED[v]) return NAMED[v];
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return `#${[...m[1]].map((c) => c + c).join("")}`;
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) return `#${m[1]}`;
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "transparent";
    return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function declarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

/** True when a style string hides its element's text from a sighted visitor. */
export function styleHides(style: string): boolean {
  const s = style.replace(/\s+/g, " ");
  if (HIDING_DECL.some((re) => re.test(s))) return true;
  const d = declarations(s);
  const fg = normaliseColour(d.get("color"));
  const bgRaw = d.get("background-color") ?? d.get("background")?.split(/\s+(?![^()]*\))/)[0];
  const bg = normaliseColour(bgRaw);
  return fg !== null && bg !== null && fg !== "transparent" && fg === bg;
}

/** Simple `.class` / `#id` selectors that <style> blocks hide. */
function hidingSelectors(html: string): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!styleHides(rule[2])) continue;
      for (const sel of rule[1].split(",").map((x) => x.trim())) {
        const m = sel.match(/^([.#])([\w-]+)$/);
        if (m) (m[1] === "." ? classes : ids).add(m[2]);
      }
    }
  }
  return { classes, ids };
}

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const v = m[2] ?? "";
    out.set(m[1].toLowerCase(), v.replace(/^["']|["']$/g, ""));
  }
  return out;
}

type Hiding = "hidden" | "aria" | null;

function hiding(tag: string, rawAttrs: string, sel: { classes: Set<string>; ids: Set<string> }): Hiding {
  if (tag === "template") return "hidden";
  const a = attributes(rawAttrs);
  if (a.has("hidden")) return "hidden";
  if (a.get("style") && styleHides(a.get("style")!)) return "hidden";
  const classes = (a.get("class") ?? "").split(/\s+/).filter(Boolean);
  const shownResponsively = classes.some((c) => /^[\w-]+:(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|contents|visible)$/.test(c));
  if (!shownResponsively && classes.some((c) => c === "hidden" || c === "invisible")) return "hidden";
  if (classes.some((c) => sel.classes.has(c)) || (a.get("id") && sel.ids.has(a.get("id")!))) return "hidden";
  if (a.get("aria-hidden")?.toLowerCase() === "true") return "aria";
  return null;
}

/** Removes hidden elements; `hiddenText` holds the non-empty text a visitor would not see. */
export function stripHiddenHtml(raw: string): { html: string; hiddenText: string[] } {
  const sel = hidingSelectors(raw);
  // Comments and scripts are never shown (the sanitiser drops them); remove them first so tags
  // inside them cannot unbalance the element matching below.
  const html = raw.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const tags = [...html.matchAll(TAG)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, close: m[1] === "/", name: m[2].toLowerCase(), attrs: m[3] ?? "", selfClosing: m[4] === "/" }));
  const out: string[] = [];
  const hiddenText: string[] = [];
  let pos = 0;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.start < pos || t.close) continue;
    const h = hiding(t.name, t.attrs, sel);
    if (!h) continue;
    // Find the matching close tag (same name, depth-counted); a void or unclosed element hides only itself.
    let endAt = t.end;
    if (!VOID.has(t.name) && !t.selfClosing) {
      let depth = 1;
      for (let j = i + 1; j < tags.length; j++) {
        const u = tags[j];
        if (u.name !== t.name) continue;
        if (u.close) depth--;
        else if (!u.selfClosing) depth++;
        if (depth === 0) {
          endAt = u.end;
          break;
        }
      }
    }
    out.push(html.slice(pos, t.start));
    if (h === "hidden") {
      const text = sanitise(html.slice(t.start, endAt)).text.replace(/\s+/g, " ").trim();
      if (text) hiddenText.push(text.slice(0, 200));
    }
    pos = endAt;
  }
  out.push(html.slice(pos));
  return { html: out.join(""), hiddenText };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k]) return ENTITIES[k];
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? Number(k.slice(1)) : NaN;
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * Snapshot HTML → visible page text plus signals: hidden_text (hidden elements with text),
 * html_comment / zero_width (from the sanitiser) and prompt_injection (detected on the raw HTML,
 * so instructions inside hidden elements or comments are seen even though they are removed).
 */
export function snapshotToText(html: string): { text: string; flags: SnapshotFlag[]; hiddenText: string[] } {
  const stripped = stripHiddenHtml(html);
  const s = sanitise(stripped.html);
  const flags = new Set<SnapshotFlag>(s.flags);
  // The sanitiser saw the HTML after hidden elements were removed; screen the raw page as well.
  for (const f of sanitise(html).flags) flags.add(f);
  if (detectInjection(decodeEntities(html))) flags.add("prompt_injection");
  if (stripped.hiddenText.length) flags.add("hidden_text");
  // Entities are decoded after the sanitiser so an encoded tag is shown as text, not parsed.
  const text = decodeEntities(s.text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  const order: SnapshotFlag[] = ["zero_width", "html_comment", "hidden_text", "prompt_injection"];
  return { text, flags: order.filter((f) => flags.has(f)), hiddenText: stripped.hiddenText };
}
