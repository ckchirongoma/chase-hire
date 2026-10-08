import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("splits bold runs", () => {
    expect(parseInline("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
  });

  it("leaves an unclosed marker as text", () => {
    expect(parseInline("R30,000 **a month")).toEqual([{ text: "R30,000 **a month", bold: false }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings, paragraphs and both list kinds", () => {
    const blocks = parseMarkdown(
      ["Intro line one", "line two.", "", "## For you if", "- one", "- **two**", "", "### Steps", "1. first", "2) second", "", "End."].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["p", "h2", "ul", "h3", "ol", "p"]);
    expect(blocks[0]).toEqual({ type: "p", inline: [{ text: "Intro line one line two.", bold: false }] });
    expect(blocks[2]).toEqual({ type: "ul", items: [[{ text: "one", bold: false }], [{ text: "two", bold: true }]] });
    expect(blocks[4]).toMatchObject({ type: "ol", items: [[{ text: "first" }], [{ text: "second" }]] });
  });

  it("joins an indented continuation line onto the list item", () => {
    expect(parseMarkdown("- a long\n  item\n- next")).toEqual([
      { type: "ul", items: [[{ text: "a long item", bold: false }], [{ text: "next", bold: false }]] },
    ]);
  });

  it("starts a new block when the list kind changes or a paragraph follows a list", () => {
    expect(parseMarkdown("- a\n1. b\nafter").map((b) => b.type)).toEqual(["ul", "ol", "p"]);
  });

  it("treats a single # as a section heading and keeps HTML as literal text", () => {
    const blocks = parseMarkdown("# Title\n<script>alert(1)</script>");
    expect(blocks[0].type).toBe("h2");
    expect(blocks[1]).toEqual({ type: "p", inline: [{ text: "<script>alert(1)</script>", bold: false }] });
  });

  it("handles CRLF and empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("a\r\n\r\nb").map((b) => b.type)).toEqual(["p", "p"]);
  });
});
