// Offline stand-in for OpenRouter and JEV (TypeSafe) so tests run free and deterministic.
//
// OpenRouter /chat/completions is routed by the `X-Prompt-Version` header that lib/ai sends
// (e.g. "cv-parser.v1" → tests/stubs/prompts/cv-parser.mjs). Each prompt module default-exports
// `(body, ctx) => object`, the JSON the model would have returned.
// /embeddings returns a deterministic bag-of-words vector (identical text → similarity 1).
// JEV /systemone answers every question generically: noul → STUB_JEV_NOUL (default 0.2),
// choice → the first option, score → level 0. Prompt modules may export `jev(body)` to override.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env.STUB_PORT ?? 4010);
export const STUB_TRANSCRIPT =
  "I personally built the nightly reporting job in Python and SQL on Postgres. I chose incremental loads over full reloads, " +
  "and measured run time before and after: it went from 40 minutes to 6. The hardest part was duplicate customers, which I fixed " +
  "with a unique key and a quarantine table. Next time I would add alerting earlier.";
const here = path.dirname(fileURLToPath(import.meta.url));

const handlers = {};
const jevHandlers = [];
for (const file of fs.readdirSync(path.join(here, "prompts"))) {
  if (!file.endsWith(".mjs")) continue;
  const mod = await import(pathToFileURL(path.join(here, "prompts", file)).href);
  handlers[file.replace(/\.mjs$/, "")] = mod.default;
  if (mod.jev) jevHandlers.push(mod.jev);
}

export function embedding(text, dims) {
  const v = new Array(dims).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = crypto.createHash("md5").update(w).digest();
    v[h.readUInt32BE(0) % dims] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function jevAnswer(body) {
  for (const h of jevHandlers) {
    const res = h(body);
    if (res) return res;
  }
  const noul = Number(process.env.STUB_JEV_NOUL ?? 0.2);
  const answers = {};
  for (const [id, q] of Object.entries(body.questions ?? {})) {
    if (q.type === "noul") answers[id] = { type: "noul", noul };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[id] = { type: "choice", choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (keys.length - 1 || 1)])) };
    } else answers[id] = { type: "score", score: 0, confidence: 0.9, probabilities: { 0: 0.9 }, legend: {} };
  }
  return { model: "jev-stub", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    try {
      if (req.url.endsWith("/chat/completions")) {
        const version = String(req.headers["x-prompt-version"] ?? "cv-parser.v1");
        const key = version.replace(/\.v\d+$/, "");
        const handler = handlers[key];
        if (!handler) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: { code: 500, message: `no stub for ${version}` } }));
        }
        const user = body.messages.find((m) => m.role === "user");
        const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
        const system = body.messages.find((m) => m.role === "system")?.content ?? "";
        const out = handler(body, { text, system, version });
        return res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(out) } }] }));
      }
      if (req.url.endsWith("/audio/transcriptions")) {
        // Tests can send fake "audio" whose bytes are UTF-8 "TEXT:<transcript>"; anything else
        // (e.g. a real browser recording from a fake microphone) gets a fixed, specific answer.
        const bytes = Buffer.from(String(body?.input_audio?.data ?? ""), "base64");
        const asText = bytes.toString("utf8");
        const text = asText.startsWith("TEXT:") ? asText.slice(5) : STUB_TRANSCRIPT;
        return res.end(JSON.stringify({ text, model: body.model }));
      }
      if (req.url.endsWith("/embeddings")) {
        return res.end(JSON.stringify({ model: body.model, data: [{ embedding: embedding(String(body.input), body.dimensions ?? 1536) }] }));
      }
      if (req.url.endsWith("/systemone")) return res.end(JSON.stringify(jevAnswer(body)));
      if (req.url === "/health") return res.end("{}");
      res.statusCode = 404;
      res.end("{}");
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: 500, message: String(err) } }));
    }
  });
});

export function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().then(() => console.log(`ai stub on ${PORT}`));
}
