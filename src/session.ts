import type { Env } from "./env";
import { sha256Hex } from "./util";

/**
 * Dashboard sessions: a random token in an HttpOnly cookie, stored server-side only as its hash.
 *
 * Minted by the same passkey ceremony that authorises a machine, so signing a machine in also opens the
 * dashboard without a second prompt. `SameSite=Strict` keeps the cookie off every cross-site request,
 * including a hostile page's WebSocket to `/dashboard/live`.
 */

const COOKIE = "skill_sync_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), now, now + SESSION_MS).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return cookie(token, SESSION_MS / 1000);
}

export async function hasSession(request: Request, env: Env): Promise<boolean> {
  const token = readCookie(request);
  if (token === undefined) return false;
  // Local development only: `.dev.vars` sets DEV_TOKEN, a deployment never does.
  if (env.DEV_TOKEN && token === env.DEV_TOKEN) return true;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token)).first<{ expires_at: number }>();
  return row !== null && row.expires_at > Date.now();
}

/** Returns the cookie header that clears the session in the browser. */
export async function endSession(request: Request, env: Env): Promise<string> {
  const token = readCookie(request);
  if (token !== undefined) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return cookie("", 0);
}

/** For `/dev/session`, which exists only while DEV_TOKEN is set. */
export const devSessionCookie = (token: string): string => cookie(token, SESSION_MS / 1000);

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function readCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}
