/**
 * Generates the CV test fixtures. Run from the repo root:
 *   npx tsx tests/fixtures/make-fixtures.ts
 *
 * All people, employers and contact details are fictional. Output is deterministic,
 * so re-running the script produces byte-identical files.
 *
 * Writes:
 *   cv-sample.pdf    - Test Candidate (BA), real text layer
 *   cv-sample-2.pdf  - Ayanda Fixture (SWE), a different person
 *   cv-scanned.pdf   - valid PDF with no text layer (stands in for a scanned CV)
 *   cv-sample.docx   - Test Candidate again, as DOCX (built with jszip, a mammoth dependency)
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const OUT_DIR = __dirname;

const CV_1 = [
  "Test Candidate",
  "Business Analyst | Cape Town",
  "Email: test.candidate@example.co.za | Phone: 082 555 0101",
  "LinkedIn: linkedin.com/in/test-candidate",
  "",
  "EXPERIENCE",
  "Senior Business Analyst, Example Retail Group (2022-03 to present)",
  "- Mapped the month-end close process and cut it from 10 working days to 4.",
  "- Found 1,240 duplicate supplier records in the vendor master, saving R1.2m a year.",
  "- Ran 18 discovery workshops with finance and operations stakeholders.",
  "Business Analyst, Fictional Logistics (2019-01 to 2022-02)",
  "- Built a Power BI dashboard used by 45 depot managers every week.",
  "- Wrote the requirements for a route-planning MVP that reduced fuel spend by 12%.",
  "",
  "EDUCATION",
  "BCom Information Systems, University of Example, 2018",
  "",
  "SKILLS",
  "Requirements elicitation, SQL, Power BI, Excel, process mapping, Figma",
];

const CV_2 = [
  "Ayanda Fixture",
  "Software Engineer | Johannesburg",
  "Email: ayanda.fixture@example.org | Phone: +27 71 555 0199",
  "GitHub: github.com/ayanda-fixture",
  "",
  "EXPERIENCE",
  "Software Engineer, Sample Payments (2021-06 to present)",
  "- Moved the settlement service to Postgres with row-level security for 3 tenants.",
  "- Cut p95 API latency from 900 ms to 180 ms by adding caching and query indexes.",
  "- Set up CI with automated tests, raising coverage from 35% to 80%.",
  "Junior Developer, Placeholder Media (2019-02 to 2021-05)",
  "- Built a Next.js content site serving 200,000 monthly visitors.",
  "",
  "EDUCATION",
  "BSc Computer Science, Example Technical University, 2018",
  "",
  "SKILLS",
  "TypeScript, Next.js, Node.js, PostgreSQL, Docker, AWS, Vitest",
];

// ---------- PDF ----------

function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function textContent(lines: string[]): string {
  const ops = ["BT", "/F1 11 Tf", "15 TL", "50 790 Td"];
  for (const line of lines) {
    if (line) ops.push(`${pdfString(line)} Tj`);
    ops.push("T*");
  }
  ops.push("ET");
  return ops.join("\n");
}

/** Assembles a single-page PDF with a correct xref table. */
function buildPdf(content: string, withFont: boolean): Buffer {
  const resources = withFont ? "/Resources << /Font << /F1 4 0 R >> >>" : "/Resources << >>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${resources} /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------- DOCX ----------

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildDocx(lines: string[]): Promise<Buffer> {
  const date = new Date("2026-01-01T00:00:00Z");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    { date, createFolders: false },
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    { date, createFolders: false },
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    { date, createFolders: false },
  );
  const paragraphs = lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(l)}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
    { date, createFolders: false },
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------- main ----------

async function main() {
  const write = (name: string, buf: Buffer) => {
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    console.log(`wrote tests/fixtures/${name} (${buf.length} bytes)`);
  };

  write("cv-sample.pdf", buildPdf(textContent(CV_1), true));
  write("cv-sample-2.pdf", buildPdf(textContent(CV_2), true));
  // No fonts, no text operators: only a filled rectangle, like a page image with no OCR layer.
  write("cv-scanned.pdf", buildPdf("0.85 g\n50 50 495 742 re\nf", false));
  write("cv-sample.docx", await buildDocx(CV_1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
