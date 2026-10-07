import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Doc 04 legal framing: the product is the "Reasoning Assessment" and must never be described
// with certain terms, in UI text or in code. The terms are assembled so this file does not contain them.
const BANNED = new RegExp(`\\b(${['I' + 'Q', 'apti' + 'tude', 'psycho' + 'metric'].join('|')})`, 'i');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('wording', () => {
  it('no banned terms anywhere in lib/reasoning', () => {
    const all = files(__dirname);
    expect(all.length).toBeGreaterThan(10);
    for (const f of all) expect({ f, hit: BANNED.exec(readFileSync(f, 'utf8'))?.[0] }).toEqual({ f, hit: undefined });
  });
});
