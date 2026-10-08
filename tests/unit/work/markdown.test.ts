import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInline, parseMarkdown, renderMarkdown } from "@/lib/work/markdown";

const html = (md: string) => renderToStaticMarkup(renderMarkdown(md) as never);

describe("brief markdown renderer", () => {
  it("escapes HTML everywhere (text, emphasis, code, headings, lists, quotes)", () => {
    const out = html(
      [
        "# <h1 onclick=x>Title</h1>",
        "<script>alert(1)</script> **<img src=x onerror=alert(1)>** *<b>i</b>* `<iframe>`",
        "- <a href=\"javascript:alert(1)\">x</a>",
        "> <svg onload=alert(1)>",
        "[link](javascript:alert(1)) ![img](http://x/y.png)",
      ].join("\n\n"),
    );
    expect(out).not.toMatch(/<script|<img|<iframe|<svg|<a |<b>|onclick=x>|<h1 onclick/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("<strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
    expect(out).toContain("<code");
    expect(out).toContain("&lt;iframe&gt;");
    // Links and images are not supported: they stay as plain text.
    expect(out).toContain("[link](javascript:alert(1))");
  });

  it("renders headings, paragraphs, bold, italic and inline code", () => {
    const out = html("## Solution Brief\n\n**Agreed direction:** fix *contactability* first, see `kopano_vsam_extract.xlsx`.");
    expect(out).toContain('<h3 class="text-lg font-semibold">Solution Brief</h3>');
    expect(out).toContain("<strong>Agreed direction:</strong> fix <em>contactability</em> first");
    expect(out).toContain(">kopano_vsam_extract.xlsx</code>");
  });

  it("keeps snake_case and lone asterisks as text", () => {
    expect(parseInline("base_month1_drift and 5 * 3 * 2")).toEqual([{ type: "text", text: "base_month1_drift and 5 * 3 * 2" }]);
    expect(parseInline("\\*not italic\\*")).toEqual([{ type: "text", text: "*not italic*" }]);
  });

  it("nests lists by indentation, including a list right after a paragraph line", () => {
    const blocks = parseMarkdown(
      ["**You have:**", "1. `file.xlsx`, containing:", "   - sheet one", "   - sheet two", "2. A chat", "3. The internet", "", "After."].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
    const list = blocks[1] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(list.items[0].children[0]).toMatchObject({ type: "list", ordered: false });
    expect((list.items[0].children[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("handles three levels with 2-space indents and blockquotes", () => {
    const out = html(["- **Current stack:**", "  - FileMaker", "    - deep", "- People", "", "> quoted *line*", "> second"].join("\n"));
    expect(out.match(/<ul/g)).toHaveLength(3);
    expect(out).toContain("<blockquote");
    expect(out).toContain("quoted <em>line</em> second");
  });

  it("survives hostile or degenerate input", () => {
    expect(() => html("*".repeat(5000))).not.toThrow();
    expect(() => html(`${"> ".repeat(50)}deep`)).not.toThrow();
    expect(() => html(Array.from({ length: 30 }, (_, i) => `${" ".repeat(i * 2)}- level ${i}`).join("\n"))).not.toThrow();
    expect(html("")).toBe('<div class="space-y-3 text-sm leading-relaxed"></div>');
  });
});
