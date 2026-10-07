// Pulls identity out of the <cv> text with regexes.
export default function cvParser(_body, { text }) {
  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? null;
  const phone = text.match(/(\+27|0)[\d ()-]{8,14}\d/)?.[0] ?? null;
  const linkedin = text.match(/linkedin\.com\/in\/[\w-]+/i)?.[0] ?? null;
  const name = text.split(/\\n|\n/).map((l) => l.trim()).find((l) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(l)) ?? null;
  return {
    identity: { full_name: name, email, phone, linkedin, github: null, city: "Cape Town" },
    education: [],
    roles: [
      {
        employer: "Example Co",
        title: "Analyst",
        start: "2022-01",
        end: "present",
        claims: [
          { id: "c1", text: "Built an automated reporting pipeline that saved 20 hours a week", quantified: true, skills: ["SQL", "Python"] },
          { id: "c2", text: "Cleaned a 50,000-row customer dataset and removed 3,000 duplicates", quantified: true, skills: ["Excel"] },
          { id: "c3", text: "Ran discovery workshops with operations managers", quantified: false, skills: ["Facilitation"] },
        ],
      },
    ],
    skills: ["SQL", "Python", "Excel"],
    links: [],
    summary: "Stub summary",
  };
}
