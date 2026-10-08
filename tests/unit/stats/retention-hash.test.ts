import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashUserId, retentionPepper } from "@/lib/server/retention";

const ID = "6f1c2b9e-1d2a-4c55-9a3e-0b7f2a1c9d10";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hashed ids for the decision archive and purge log (docs/12)", () => {
  it("is sha256(user_id + pepper), hex, stable per person", () => {
    const pepper = "a-long-server-only-pepper";
    expect(hashUserId(ID, pepper)).toBe(createHash("sha256").update(ID + pepper).digest("hex"));
    expect(hashUserId(ID, pepper)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUserId(ID, pepper)).toBe(hashUserId(ID, pepper));
    expect(hashUserId(ID, pepper)).not.toBe(hashUserId(ID, `${pepper}x`));
  });

  it("uses RETENTION_PEPPER when it is set", () => {
    vi.stubEnv("RETENTION_PEPPER", "0123456789abcdef-pepper");
    expect(retentionPepper()).toBe("0123456789abcdef-pepper");
    expect(hashUserId(ID)).toBe(createHash("sha256").update(`${ID}0123456789abcdef-pepper`).digest("hex"));
  });

  it("refuses to run in production without a pepper of at least 16 characters", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("RETENTION_PEPPER", "");
    expect(() => retentionPepper()).toThrow(/RETENTION_PEPPER/);
    vi.stubEnv("RETENTION_PEPPER", "too-short");
    expect(() => retentionPepper()).toThrow(/RETENTION_PEPPER/);
  });

  it("falls back to a fixed test pepper only under tests", () => {
    vi.stubEnv("RETENTION_PEPPER", "");
    expect(retentionPepper()).toMatch(/test/);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    expect(() => retentionPepper()).toThrow(/RETENTION_PEPPER/);
  });
});
