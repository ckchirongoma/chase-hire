// Minimal stand-in for the OpenRouter API so E2E tests run offline and free.
// /chat/completions: pulls identity out of the <cv> text with regexes.
// /embeddings: deterministic bag-of-words vector, so identical CVs get similarity 1.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.STUB_PORT ?? 4010);

function cvJson(text) {
  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? null;
  const phone = text.match(/(\+27|0)[\d ()-]{8,14}\d/)?.[0] ?? null;
  const linkedin = text.match(/linkedin\.com\/in\/[\w-]+/i)?.[0] ?? null;
  const name = text.split("\n").map((l) => l.trim()).find((l) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(l)) ?? null;
  return {
    identity: { full_name: name, email, phone, linkedin, github: null, city: "Cape Town" },
    education: [],
    roles: [{ employer: "Example Co", title: "Analyst", start: "2022-01", end: "present", claims: [{ id: "c1", text: "Built a reporting pipeline", quantified: false, skills: ["SQL"] }] }],
    skills: ["SQL"],
    links: [],
    summary: "Stub summary",
  };
}

function embedding(text, dims) {
  const v = new Array(dims).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = crypto.createHash("md5").update(w).digest();
    v[h.readUInt32BE(0) % dims] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/chat/completions")) {
        const user = json.messages.find((m) => m.role === "user");
        const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
        res.end(JSON.stringify({ model: json.model, choices: [{ message: { role: "assistant", content: JSON.stringify(cvJson(text)) } }] }));
      } else if (req.url.endsWith("/embeddings")) {
        res.end(JSON.stringify({ model: json.model, data: [{ embedding: embedding(String(json.input), json.dimensions ?? 1536) }] }));
      } else if (req.url === "/health") {
        res.end("{}");
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`openrouter stub on ${PORT}`));
