import { describe, expect, it } from "vitest";
import { DraftSchema, parseSubmission } from "@/lib/work/schema";
import { displayName, extOf, safeFileName, STAGE_FIELDS, uploadPath } from "@/lib/work/stages";

const transcript = "Hi Lerato, this is the renewal desk. It does three things and here they are.";

describe("submission schemas per stage", () => {
  it("ba_part1 takes only the memo", () => {
    expect(parseSubmission("ba_part1", { memo: "u/a/1-memo.pdf" })).toMatchObject({ ok: true });
    expect(parseSubmission("ba_part1", {})).toMatchObject({ ok: false });
    expect(parseSubmission("ba_part1", { memo: "u/a/m.pdf", repo_url: "https://github.com/a/b" })).toMatchObject({ ok: false });
    expect(parseSubmission("ba_part1", { memo: "../other/m.pdf" })).toMatchObject({ ok: false, error: "Invalid file path" });
  });

  it("ba_part2 requires https links and the transcript; extras are optional", () => {
    const ok = parseSubmission("ba_part2", { mvp_url: "https://desk.example.com", handoff: "u/a/h.md", loom_url: "https://www.loom.com/share/x", loom_transcript: transcript });
    expect(ok).toMatchObject({ ok: true, data: { extras: [] } });
    expect(parseSubmission("ba_part2", { mvp_url: "http://desk.example.com", handoff: "u/a/h.md", loom_url: "https://loom.com/x", loom_transcript: transcript })).toMatchObject({
      ok: false,
      field: "mvp_url",
    });
    expect(parseSubmission("ba_part2", { mvp_url: "https://desk.example.com", handoff: "u/a/h.md", loom_url: "https://loom.com/x", loom_transcript: "short" })).toMatchObject({
      ok: false,
      field: "loom_transcript",
    });
    expect(
      parseSubmission("ba_part2", { mvp_url: "https://d.example.com", handoff: "u/a/h.md", extras: Array(6).fill("u/a/e.png"), loom_url: "https://loom.com/x", loom_transcript: transcript }),
    ).toMatchObject({ ok: false });
  });

  it("swe_test1 normalises the GitHub repo URL", () => {
    const res = parseSubmission("swe_test1", {
      repo_url: "https://github.com/me/desk.git",
      deployed_url: "https://desk.example.com",
      test_logins: "agent1@example.co.za / pw1",
      loom_url: "https://loom.com/share/y",
      loom_transcript: transcript,
    });
    expect(res).toMatchObject({ ok: true, data: { repo_url: "https://github.com/me/desk" } });
    expect(parseSubmission("swe_test1", { repo_url: "https://gitlab.com/me/desk", deployed_url: "https://d.example.com", test_logins: "a@b.c pw pw pw", loom_url: "https://l.example.com", loom_transcript: transcript })).toMatchObject({
      ok: false,
      field: "repo_url",
    });
    expect(parseSubmission("swe_test1", { repo_url: "https://github.com/me/desk", deployed_url: "https://127.0.0.1", test_logins: "a@b.c pw pw pw", loom_url: "https://l.example.com", loom_transcript: transcript })).toMatchObject({
      ok: false,
      field: "deployed_url",
    });
  });

  it("swe_test2 takes the memo and the Loom", () => {
    expect(parseSubmission("swe_test2", { memo: "u/a/m.md", loom_url: "https://loom.com/share/z", loom_transcript: transcript })).toMatchObject({ ok: true });
  });

  it("every stage's form fields line up with its schema", () => {
    expect(STAGE_FIELDS.swe_test1.some((f) => f.kind === "file")).toBe(false);
    expect(STAGE_FIELDS.ba_part1.map((f) => f.name)).toEqual(["memo"]);
  });
});

describe("draft schema", () => {
  it("accepts text and file lists, refuses over 50 KB", () => {
    expect(DraftSchema.safeParse({ mvp_url: "https://x", extras: ["u/a/1.png"] }).success).toBe(true);
    expect(DraftSchema.safeParse({ loom_transcript: "x".repeat(39_000), notes: "y".repeat(12_000) }).success).toBe(false);
    expect(DraftSchema.safeParse({ "Bad-Key": "x" }).success).toBe(false);
  });
});

describe("file names", () => {
  it("makes storage-safe names and paths", () => {
    expect(safeFileName("../../My Memo (final) v2.PDF")).toBe("My_Memo_final_v2.pdf");
    expect(safeFileName("résumé.docx")).toBe("resume.docx");
    expect(safeFileName(".docx")).toBe("file.docx");
    expect(uploadPath("u1", "a1", "ERD diagram.png", 1700000000000)).toBe("u1/a1/1700000000000-ERD_diagram.png");
    expect(displayName("u1/a1/1700000000000-ERD_diagram.png")).toBe("ERD_diagram.png");
    expect(extOf("x.JPEG")).toBe("jpeg");
    expect(extOf("x.exe")).toBeNull();
  });
});
