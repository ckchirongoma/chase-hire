/**
 * What the candidate's "Interview the client" tab sees. No fact ids, gate probabilities or
 * model details ever reach the browser.
 */
export type PersonaMessageView = { id: string; role: "candidate" | "persona"; content: string; at: string };

export type PersonaView =
  | { status: "none"; canStart: boolean; notice: string | null; cap: number }
  | {
      status: "active" | "closed";
      sessionId: string;
      messages: PersonaMessageView[];
      deadlineAt: string;
      serverNow: string;
      cap: number;
      remaining: number;
      /** A message is waiting for Lerato's reply (e.g. sent from another tab). */
      pending: boolean;
      closedReason: "cap" | "deadline" | "submitted" | null;
      notice: string | null;
    };
