import { NextResponse } from "next/server";

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function errorJson(status: number, error: string, extra?: Record<string, unknown>, headers?: Record<string, string>) {
  return json({ error, ...extra }, status, headers);
}

/** Reads a JSON body; null when it is missing or not JSON. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
