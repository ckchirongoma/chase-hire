import type { SynthRng } from "./rng";

/**
 * Fictional, SA-flavoured name pools (docs/11 "Fake data sources"). Nothing here comes from
 * context/: no client, network, vendor, label or employee names (first names or surnames of
 * anyone named there), and no real phone numbers. lib/synth/banned.ts checks every output.
 */

export const SURNAMES = [
  "Mokoena", "Nkosi", "Dlamini", "Naidoo", "van der Merwe", "Botha", "Pillay", "Mahlangu", "Molefe", "Khumalo",
  "Ndlovu", "Sithole", "Mthembu", "Pretorius", "Venter", "Govender", "Maseko", "Ngcobo", "Radebe", "Petersen",
  "Jacobs", "Daniels", "Mokwena", "Tshabalala", "Baloyi", "Maluleke", "Nel", "Smit", "Fourie", "Coetzee",
  "Steyn", "Kruger", "Hendricks", "Adams", "Moodley", "Reddy", "Chetty", "Nkuna", "Shabalala", "Mabaso",
  "Mnisi", "Sibiya", "Mkhize", "Cele", "Hadebe", "Mazibuko", "Zwane", "Motaung", "Letsoalo", "Phiri",
  "Mofokeng", "Sebola", "Marais", "du Plessis", "Mathebula", "Olivier", "Booysen", "Abrahams", "Isaacs", "Khoza",
  "Masilela", "Ntuli", "Mabena", "Rakgoale", "Seakamela", "Mashaba", "Tau", "Moloi", "Kekana", "Manamela",
] as const;

export const FIRST_NAMES = [
  "Ayanda", "Bongani", "Busisiwe", "Chantal", "Dineo", "Esther", "Farhana", "Gugu", "Hlengiwe", "Itumeleng",
  "Jabulani", "Karabo", "Kagiso", "Lindiwe", "Lwazi", "Mpho", "Nandi", "Naledi", "Nomvula", "Palesa",
  "Pieter", "Refilwe", "Sibusiso", "Sipho", "Tebogo", "Thandeka", "Themba", "Tumelo", "Vusi", "Wandile",
  "Xolani", "Yusuf", "Zanele", "Zinhle", "Anele", "Bheki", "Charmaine", "Deon", "Elmarie", "Fikile",
  "Kamogelo", "Keabetswe", "Masego", "Nompumelelo", "Oratile", "Precious", "Rethabile", "Sanele", "Thato", "Unathi",
  "Zodwa", "Riaan", "Shireen", "Priya", "Kevin", "Annelie", "Lebogang", "Neo", "Boitumelo", "Siyabonga",
] as const;

const INDUSTRIES = [
  "Logistics", "Construction", "Plumbing", "Electrical", "Holdings", "Motors", "Engineering", "Catering", "Security",
  "Transport", "Projects", "Consulting", "Farming", "Pharmacy", "Hardware", "Auto Spares", "Printing", "Cleaning Services",
  "Properties", "Investments", "Butchery", "Tyres", "Furniture", "Fencing", "Panelbeaters", "Medical Supplies", "Bakery",
  "Travel", "Steel", "Accounting", "Couriers", "Glass", "Roofing", "Irrigation", "Signage", "Solar",
] as const;

const WORDS = [
  "Ubuntu", "Masakhane", "Imbali", "Lesedi", "Thuthuka", "Siyaphambili", "Kgotso", "Bophelo", "Phakama", "Zenzele",
  "Khanyisa", "Isibane", "Tshepo", "Naledi", "Letlotlo", "Umoya", "Ithemba", "Amandla", "Vukani", "Karoo",
  "Highveld", "Lowveld", "Bushveld", "Protea", "Fynbos", "Baobab", "Marula", "Acacia", "Kudu", "Impala",
  "Duiker", "Blouberg", "Waterberg", "Magalies", "Sedibeng", "Mopane", "Kalahari", "Tugela", "Limpopo", "Vaal",
] as const;

export interface Company {
  /** As written in the base export (upper case). */
  name: string;
  legalSuffix: "(PTY) LTD" | "CC" | "";
  /** Upper-case name without suffix and punctuation, single-spaced: the identity-resolution key. */
  normalised: string;
  /** Slug for fictional emails. */
  slug: string;
}

export function normaliseCompanyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\(\s*PTY\s*\)\s*LTD\.?/g, " ")
    .replace(/\bPTY\s*LTD\.?\b/g, " ")
    .replace(/\bPROPRIETARY\s+LIMITED\b/g, " ")
    .replace(/\bC\.?C\.?$/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** One fictional company in a random SA-flavoured pattern. */
export function makeCompany(rng: SynthRng): Company {
  const pattern = rng.weighted([
    ["surname_industry", 45],
    ["word_trading", 20],
    ["two_surnames", 12],
    ["word_industry", 15],
    ["initials", 8],
  ] as const);
  let core: string;
  let suffix: Company["legalSuffix"];
  switch (pattern) {
    case "surname_industry":
      core = `${rng.pick(SURNAMES)} ${rng.pick(INDUSTRIES)}`;
      suffix = "(PTY) LTD";
      break;
    case "word_trading":
      core = `${rng.pick(WORDS)} Trading`;
      suffix = "CC";
      break;
    case "two_surnames":
      core = `${rng.pick(SURNAMES)} & ${rng.pick(SURNAMES)} ${rng.pick(INDUSTRIES)}`;
      suffix = rng.chance(0.6) ? "(PTY) LTD" : "CC";
      break;
    case "word_industry":
      core = `${rng.pick(WORDS)} ${rng.pick(INDUSTRIES)}`;
      suffix = rng.chance(0.7) ? "(PTY) LTD" : "";
      break;
    default:
      core = `${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))} ${rng.pick(SURNAMES)} ${rng.pick(INDUSTRIES)}`;
      suffix = "CC";
  }
  const upper = core.toUpperCase();
  const name = suffix ? `${upper} ${suffix}` : upper;
  return { name, legalSuffix: suffix, normalised: normaliseCompanyName(name), slug: slugify(core) };
}

/** Unique companies (by normalised name). */
export function makeCompanies(rng: SynthRng, n: number, taken = new Set<string>()): Company[] {
  const out: Company[] = [];
  let guard = 0;
  while (out.length < n) {
    if (++guard > n * 50) throw new Error("makeCompanies: name pool exhausted");
    const c = makeCompany(rng);
    if (taken.has(c.normalised)) continue;
    taken.add(c.normalised);
    out.push(c);
  }
  return out;
}

/** A spacing / "(PTY) LTD" variant of a company name that normalises to the same key. */
export function nameVariant(rng: SynthRng, c: Company): string {
  const base = c.legalSuffix ? c.name.slice(0, -c.legalSuffix.length).trim() : c.name;
  const variants =
    c.legalSuffix === "(PTY) LTD"
      ? [`${base} (PTY)LTD`, `${base} PTY LTD`, `${base.replace(/ /, "  ")} (PTY) LTD`, `${base}(PTY) LTD`]
      : c.legalSuffix === "CC"
        ? [`${base}  CC`, `${base} C.C.`, `${base.replace(/ /, "  ")} CC`]
        : [`${base} (PTY) LTD`, `${base}  `, `${base.replace(/ /, "  ")}`];
  return rng.pick(variants);
}

export interface Person {
  first: string;
  last: string;
  full: string;
}

export function makePerson(rng: SynthRng, avoid = new Set<string>()): Person {
  for (let i = 0; i < 200; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(SURNAMES);
    const full = `${first} ${last}`;
    if (avoid.has(full)) continue;
    avoid.add(full);
    return { first, last, full };
  }
  throw new Error("makePerson: name pool exhausted");
}

export function personEmail(p: Person): string {
  return `${slugify(p.first)}.${slugify(p.last)}@example.co.za`;
}

export function companyEmail(c: Company, rng: SynthRng): string {
  return `${rng.pick(["info", "accounts", "admin", "office", "sales"])}.${c.slug.slice(0, 24)}@example.co.za`;
}

// ───────────────────────── Phone numbers ─────────────────────────

const MOBILE_PREFIXES = ["060", "061", "062", "063", "064", "065", "066", "067", "068", "071", "072", "073", "074", "076", "078", "079", "081", "082", "083", "084"] as const;
const LANDLINE_PREFIXES = ["011", "012", "021", "031", "041", "051", "013", "015", "016", "018"] as const;

/** Numbers from the docs' examples / real lists that must never be generated (national format, 10 digits). */
const NEVER = new Set(["0832728600", "0612327731"]);

const neverDigits = (n: string) => [...NEVER].some((x) => n.includes(x.slice(3)) || n.includes(x.slice(1)));

/** Random 10-digit national mobile number, e.g. 0821234567 (never one from a real list). */
export function makeMobile(rng: SynthRng, taken?: Set<string>): string {
  for (;;) {
    const n = `${rng.pick(MOBILE_PREFIXES)}${String(rng.int(0, 9_999_999)).padStart(7, "0")}`;
    if (NEVER.has(n) || neverDigits(n) || taken?.has(n)) continue;
    taken?.add(n);
    return n;
  }
}

export function makeLandline(rng: SynthRng, taken?: Set<string>): string {
  for (;;) {
    const n = `${rng.pick(LANDLINE_PREFIXES)}${String(rng.int(2_000_000, 9_999_999))}`;
    if (NEVER.has(n) || neverDigits(n) || taken?.has(n)) continue;
    taken?.add(n);
    return n;
  }
}

export const isMobileNational = (n: string) => /^0[6-8]\d{8}$/.test(n);

/** "(083) 1234567" display style. */
export const bracketStyle = (n: string) => `(${n.slice(0, 3)}) ${n.slice(3)}`;
/** National number → E.164 (+27...). */
export const toE164 = (n: string) => `+27${n.slice(1)}`;
/** National number → MSISDN as the network stores it (27821234567). */
export const toMsisdn = (n: string) => Number(`27${n.slice(1)}`);
