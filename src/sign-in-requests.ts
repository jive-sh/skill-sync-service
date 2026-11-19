import type { SignInClaim, SignInRequestCreated } from "@jive-sh/skill-sync";
import type { Env } from "./env";
import { randomToken } from "./session";
import { json, sha256Hex } from "./util";

/**
 * Signing a machine in, from a browser on any computer.
 *
 * The daemon opens a request naming its machine and gets two values: a page address carrying the request's id,
 * and a claim secret it keeps in memory. A person opens the page, on this computer or their phone, and approves
 * with their passkey (`approveSignInRequest`, from `loginVerify`). The daemon claims the request every few
 * seconds with its secret; once approved, the claim mints the machine's token and deletes the request, so a
 * token is handed out once, and only to the process holding the secret. The page never sees a token, and
 * neither does anything that only knows the page's address.
 *
 * It is the flow `jive login` uses with `@jive-sh/server`. It replaces handing the token to a listener on the
 * machine's 127.0.0.1, which a browser on another computer cannot reach.
 */

/** Long enough to fetch a phone and approve; short enough that a request left open is soon useless. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** A machine name as the dashboard shows it; the daemon writes one from the hostname. */
const MAX_MACHINE_LENGTH = 80;

export async function createSignInRequest(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { machine?: unknown };
  const machine = typeof body.machine === "string" ? body.machine.trim() : "";
  if (machine === "" || machine.length > MAX_MACHINE_LENGTH || /[\u0000-\u001f]/.test(machine)) {
    return json({ error: `machine must be a name of 1 to ${MAX_MACHINE_LENGTH} characters` }, 400);
  }
  const requestId = randomToken();
  const claimSecret = randomToken();
  const now = Date.now();
  const expiresAt = now + REQUEST_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sign_in_requests WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sign_in_requests (request_id, claim_hash, machine, expires_at) VALUES (?, ?, ?, ?)")
      .bind(requestId, await sha256Hex(claimSecret), machine, expiresAt),
  ]);
  const created: SignInRequestCreated = { url: `${new URL(request.url).origin}/approve?request=${requestId}`, claimSecret, expiresAt };
  return json(created);
}

/** The machine an open request would sign in, for the page that approves it; undefined once it expired or was claimed. */
export async function openSignInRequest(env: Env, requestId: string): Promise<{ readonly machine: string } | undefined> {
  const row = await env.DB.prepare("SELECT machine FROM sign_in_requests WHERE request_id = ? AND expires_at > ?")
    .bind(requestId, Date.now()).first<{ machine: string }>();
  return row === null ? undefined : { machine: row.machine };
}

/** Marks an open request approved, after a passkey check. Returns the machine it signs in, or undefined when it is not open. */
export async function approveSignInRequest(env: Env, requestId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`UPDATE sign_in_requests SET approved_at = ?1 WHERE request_id = ?2 AND expires_at > ?1
                                    RETURNING machine`).bind(Date.now(), requestId).first<{ machine: string }>();
  return row === null ? undefined : row.machine;
}

/**
 * The daemon's claim. An approved request is deleted in the same statement that reads it, so two claims racing
 * cannot both get a token.
 */
export async function claimSignInRequest(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { claimSecret?: unknown };
  if (typeof body.claimSecret !== "string") return json({ error: "claimSecret is required" }, 400);
  const claimHash = await sha256Hex(body.claimSecret);
  const now = Date.now();
  const approved = await env.DB.prepare(`DELETE FROM sign_in_requests WHERE claim_hash = ? AND approved_at IS NOT NULL AND expires_at > ?
                                         RETURNING machine`).bind(claimHash, now).first<{ machine: string }>();
  if (approved !== null) {
    const token = randomToken();
    await env.DB.prepare("INSERT INTO device_tokens (token_hash, machine, created_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(token), approved.machine, now).run();
    const claim: SignInClaim = { state: "approved", token };
    return json(claim);
  }
  const open = await env.DB.prepare("SELECT 1 AS open FROM sign_in_requests WHERE claim_hash = ? AND expires_at > ?")
    .bind(claimHash, now).first<{ open: number }>();
  const claim: SignInClaim = open === null ? { state: "expired" } : { state: "pending" };
  return json(claim);
}
