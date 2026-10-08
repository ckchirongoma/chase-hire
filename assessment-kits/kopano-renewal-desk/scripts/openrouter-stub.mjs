#!/usr/bin/env node
/**
 * A stand-in for OpenRouter's chat completions endpoint, for local runs and CI without a key.
 *
 *   node scripts/openrouter-stub.mjs [--port 55400]
 *   OPENROUTER_BASE_URL=http://127.0.0.1:55400/api/v1
 *
 * It answers with a canned summary built from the request, and records nothing.
 */
import http from "node:http";

const i = process.argv.indexOf("--port");
const port = Number(i >= 0 ? process.argv[i + 1] : process.env.STUB_PORT || 55400);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const record = (body.messages ?? []).map((m) => m.content).join("\n");
    const name = /"legal_name":"([^"]+)"/.exec(record)?.[1] ?? "this customer";
    const content = `- ${name}: renewal summary (stub reply, no model was called).`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stub", model: body.model ?? "stub", choices: [{ index: 0, message: { role: "assistant", content } }] }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`OpenRouter stub on http://127.0.0.1:${port}/api/v1`));
