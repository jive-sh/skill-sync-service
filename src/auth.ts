import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Env } from "./env";
import { createSession, randomToken } from "./session";
import { json, sha256Hex } from "./util";

/**
 * Passkey sign-in, with registration that closes behind itself.
 *
 * `/register` works only while the credentials table is empty. The first visit claims the service and
 * every later one is refused, so there is no bootstrap secret to store and nothing to remember to turn
 * off. Losing every passkey means clearing that table by hand, which is the correct amount of friction
 * for re-opening registration.
 *
 * The browser never receives a long-lived credential. It proves possession of the passkey and gets a
 * device token in exchange, which is what the daemon then uses; the passkey itself never leaves the
 * authenticator.
 */

const RP_NAME = "Jive";
/**
 * Every Jive capability authenticates with the user's global `jive.sh` passkey, so the relying party is
 * the registrable domain, not this service's hostname. A passkey bound to `skill-sync.jive.sh` would be
 * one more credential per service; bound to `jive.sh` it works on every `*.jive.sh` origin.
 */
const RP_ID = "jive.sh";
/** Five minutes is far longer than a ceremony takes and short enough that a captured one is useless. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const origin = (request: Request): string => new URL(request.url).origin;

async function credentialCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Stored so it can be checked once and then destroyed; a challenge that survives its use is replayable. */
async function rememberChallenge(env: Env, challenge: string, purpose: string): Promise<void> {
  await env.DB.prepare("INSERT INTO challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)")
    .bind(challenge, purpose, Date.now() + CHALLENGE_TTL_MS).run();
}

async function consumeChallenge(env: Env, challenge: string, purpose: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT expires_at FROM challenges WHERE challenge = ? AND purpose = ?")
    .bind(challenge, purpose).first<{ expires_at: number }>();
  await env.DB.prepare("DELETE FROM challenges WHERE challenge = ?").bind(challenge).run();
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(Date.now()).run();
  return row !== null && row.expires_at > Date.now();
}

export async function registerOptions(request: Request, env: Env): Promise<Response> {
  if (await credentialCount(env) > 0) return json({ error: "registration is closed" }, 403);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "owner",
    userID: new Uint8Array(new TextEncoder().encode("owner")),
    attestationType: "none",
    // Required on both sides, not "preferred". The server verifies with requireUserVerification on by
    // default, so asking the browser for "preferred" let Chrome skip Touch ID and the check then failed
    // with "user could not be verified". The two must agree, and the stricter setting is the right one
    // for a credential that unlocks every machine's skills.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await rememberChallenge(env, options.challenge, "register");
  return json(options);
}

export async function registerVerify(request: Request, env: Env): Promise<Response> {
  if (await credentialCount(env) > 0) return json({ error: "registration is closed" }, 403);

  const body = await request.json() as { response?: unknown; challenge?: unknown };
  if (typeof body.challenge !== "string" || !(await consumeChallenge(env, body.challenge, "register"))) {
    return json({ error: "unknown or expired challenge" }, 400);
  }

  const verified = await verifyRegistrationResponse({
    response: body.response as never,
    expectedChallenge: body.challenge,
    expectedOrigin: origin(request),
    expectedRPID: RP_ID,
  });
  if (!verified.verified || !verified.registrationInfo) return json({ error: "not verified" }, 400);

  const { credential } = verified.registrationInfo;
  await env.DB
    .prepare("INSERT INTO credentials (credential_id, public_key, counter, created_at) VALUES (?, ?, ?, ?)")
    .bind(credential.id, bytesToBase64(credential.publicKey), credential.counter, Date.now())
    .run();
  return json({ ok: true });
}

export async function loginOptions(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT credential_id FROM credentials").all<{ credential_id: string }>();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: (results ?? []).map((row) => ({ id: row.credential_id })),
    userVerification: "required",
  });
  await rememberChallenge(env, options.challenge, "login");
  return json(options);
}

/**
 * Verifies the assertion, opens a dashboard session in this browser, and — when a machine is signing
 * in — mints that machine's token.
 *
 * The machine token is returned to the page, which hands it to a listener on 127.0.0.1 — never to an
 * address the request supplied, so a page that tricks you into signing in cannot collect it.
 */
export async function loginVerify(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { response?: unknown; challenge?: unknown; machine?: unknown };
  if (typeof body.challenge !== "string" || !(await consumeChallenge(env, body.challenge, "login"))) {
    return json({ error: "unknown or expired challenge" }, 400);
  }

  const id = (body.response as { id?: string } | undefined)?.id;
  const stored = await env.DB
    .prepare("SELECT credential_id, public_key, counter FROM credentials WHERE credential_id = ?")
    .bind(id ?? "").first<{ credential_id: string; public_key: string; counter: number }>();
  if (stored === null) return json({ error: "unknown credential" }, 400);

  const verified = await verifyAuthenticationResponse({
    response: body.response as never,
    expectedChallenge: body.challenge,
    expectedOrigin: origin(request),
    expectedRPID: RP_ID,
    credential: {
      id: stored.credential_id,
      publicKey: base64ToBytes(stored.public_key),
      counter: stored.counter,
    },
  });
  if (!verified.verified) return json({ error: "not verified" }, 400);

  // A counter that fails to advance is the signature of a cloned authenticator, so the new value is
  // recorded even though nothing here rejects on it yet.
  await env.DB.prepare("UPDATE credentials SET counter = ? WHERE credential_id = ?")
    .bind(verified.authenticationInfo.newCounter, stored.credential_id).run();

  const session = await createSession(env);
  if (typeof body.machine !== "string") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": session },
    });
  }

  const token = randomToken();
  await env.DB
    .prepare("INSERT INTO device_tokens (token_hash, machine, created_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), body.machine, Date.now()).run();
  return new Response(JSON.stringify({ token }), {
    headers: { "content-type": "application/json", "set-cookie": session },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length));
  const decoded = atob(value);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.subarray(0, decoded.length) as Uint8Array<ArrayBuffer>;
}
