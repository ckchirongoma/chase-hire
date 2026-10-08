import ExcelJS from "exceljs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

/**
 * Helpers for the database tests (`npm run test:db`, local stack from `npx supabase start`).
 * They act through the same APIs the app uses: REST with a user's session, or the server key.
 */

export const DB_TESTS = process.env.RUN_DB_TESTS === "1";
const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const publishable = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export function adminClient(): SupabaseClient {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not set (copy the keys from `npx supabase status -o env` into .env.local)");
  return createClient(url(), key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function anonClient(): SupabaseClient {
  return createClient(url(), publishable(), { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  db: SupabaseClient;
}

const PASSWORD = "Test-only-password-123";

export async function makeUser(role: "agent" | "manager", label: string): Promise<TestUser> {
  const admin = adminClient();
  const email = `test-${label}-${randomUUID().slice(0, 8)}@example.co.za`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const { error: aErr } = await admin.from("agents").insert({ id, name: `Test ${label}`, email, role });
  if (aErr) throw aErr;
  const db = anonClient();
  const { data: session, error: sErr } = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !session.session) throw sErr ?? new Error("no session");
  return { id, email, token: session.session.access_token, db };
}

/** Empties the business tables and removes test users. Destroys local data: tests only. */
export async function resetDatabase(): Promise<void> {
  const admin = adminClient();
  for (const table of ["message_queue", "interactions", "allocations", "contact_points", "optouts", "quarantine_rows", "import_runs", "lines", "accounts", "customers"]) {
    const { error } = await admin.from(table).delete().not("id", "is", null);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  await admin.from("api_rate_limits").delete().not("user_id", "is", null);
  for (let page = 1; page < 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    for (const u of users) if (u.email?.startsWith("test-")) await admin.auth.admin.deleteUser(u.id);
    if (users.length < 200) break;
  }
}

export async function allocate(customerId: string, agentId: string): Promise<void> {
  const { error } = await adminClient().from("allocations").upsert({ customer_id: customerId, agent_id: agentId }, { onConflict: "customer_id" });
  if (error) throw error;
}

export async function customerIdByAccount(accountNo: string): Promise<string> {
  const { data, error } = await adminClient().from("accounts").select("customer_id").eq("account_no", accountNo).single();
  if (error) throw error;
  return data.customer_id;
}

/** Calls an app route handler as a signed-in user (bearer token, as API clients do). */
export function authedRequest(path: string, user: TestUser | null, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const BASE_HEADERS = [
  "Account No", "Reg No", "Customer Name", "Msisdn", "dealer_code", "Segment", "Contract Term", "Contract End Date", "Contract Status",
  "Month Remaining In Contract", "Priceplan", "Priceplan Name", "Device Type", "Device Model", "chg_subs",
];

export type BaseRow = Partial<Record<(typeof BASE_HEADERS)[number], string | number | Date | null>>;

/** A small base export in the Network's layout. */
export function baseRow(over: BaseRow): (string | number | Date | null)[] {
  const row: BaseRow = {
    "Account No": 10000001,
    "Reg No": "2010/123456/07",
    "Customer Name": "TEST TRADING (PTY) LTD",
    Msisdn: 821000001,
    dealer_code: "KC-VS01",
    Segment: "SME",
    "Contract Term": 24,
    "Contract End Date": new Date(Date.UTC(2027, 0, 15)),
    "Contract Status": "InContract",
    "Month Remaining In Contract": "4-6 Months",
    Priceplan: "BZT250",
    "Priceplan Name": "Biz Talk 250",
    "Device Type": null,
    "Device Model": null,
    chg_subs: 349.5,
    ...over,
  };
  return BASE_HEADERS.map((h) => row[h] ?? null);
}

export async function workbook(rows: (string | number | Date | null)[][], headers: string[] = BASE_HEADERS, sheet = "vsam base raw"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
