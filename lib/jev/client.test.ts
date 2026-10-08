import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreFraction, systemOne } from "./client";

const questions = {
  probe: { type: "noul", instructions: "needs a probe" },
  which: { type: "choice", instructions: "which", criteria: { a: "A", b: "B" } },
  level: { type: "score", instructions: "how", criteria: ["low", "mid", "high"] },
} as const;

const okBody = {
  model: "jev-1.13.0",
  answers: {
    probe: { type: "noul", noul: 0.9 },
    which: { type: "choice", choice: "b", confidence: 0.6, probabilities: { a: 0.2, b: 0.8 } },
    level: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0, "1": 0.1, "2": 0.9 } },
  },
  usage: { input_tokens: 10, output_tokens: 3 },
};

describe("JEV client", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("returns null without a key (callers fall back)", async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(await systemOne("s", questions)).toBeNull();
  });

  it("parses typed answers and sends the pinned model", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await systemOne({ a: 1 }, questions);
    expect(res!.answers.probe.noul).toBe(0.9);
    expect(res!.answers.which.choice).toBe("b");
    expect(scoreFraction(res!.answers.level, 3)).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string).model).toBe("jev-1.13.0");
  });

  it("retries once on 529 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(okBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await systemOne("s", questions)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on errors, bad shapes or mismatched answer types", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await systemOne("s", questions)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "x", answers: {} }), { status: 200 })));
    expect(await systemOne("s", questions)).toBeNull();
    const wrong = { ...okBody, answers: { ...okBody.answers, probe: okBody.answers.which } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(wrong), { status: 200 })));
    expect(await systemOne("s", questions)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await systemOne("s", questions)).toBeNull();
  });
});
