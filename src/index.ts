import {
  invalidPathReason, isSkillName, skillOf, type FoldersRequest, type FoldersResponse, type ListFilesResponse, type ListSkillsResponse,
  type MachineMismatch, type PutFileRequest, MACHINE_HEADER, MACHINE_MISMATCH_STATUS,
} from "@jive-sh/skill-sync";
import { loginOptions, loginVerify, registerOptions, registerVerify } from "./auth";
import type { Env } from "./env";
import { refinementFigures, type SnapshotTable } from "./hub";
import { approvePage, dashboardPage, registerPage, signInPage } from "./pages";
import { prefsFor, SKILL_OF_PATH } from "./prefs";
import { devSessionCookie, endSession, hasSession } from "./session";
import { approveSignInRequest, claimSignInRequest, createSignInRequest, openSignInRequest } from "./sign-in-requests";
import { json, sha256Bytes, sha256Hex } from "./util";

export { Hub } from "./hub";

/**
 * The service behind skill-sync: a file index in D1, file contents in R2 addressed by hash.
 *
 * Two kinds of caller, two kinds of credential. A browser proves a passkey, which opens a session for itself and
 * approves a machine's sign-in request; the machine's daemon claims its device token (`sign-in-requests.ts`) and
 * presents it on every request. The daemon cannot do a passkey ceremony — it may have no browser, and nobody is
 * watching it — which is the whole reason the exchange exists. Live connections (daemons and dashboards) go to the `Hub` Durable Object.
 */

interface FileRow {
  readonly path: string;
  readonly hash: string | null;
  readonly seq: number;
  readonly edited_at: number;
  readonly updated_by: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Passkey routes authenticate themselves and must come before the bearer check.
      if (method === "GET" && path === "/register") return registerPage(await isClaimed(env));
      if (method === "POST" && path === "/register/options") return await registerOptions(request, env);
      if (method === "POST" && path === "/register/verify") return await registerVerify(request, env);
      // A machine signing in: the daemon opens and claims a request; a passkey on any computer approves it.
      if (method === "POST" && path === "/cli/sign-in-requests") return await createSignInRequest(request, env);
      if (method === "POST" && path === "/cli/sign-in-requests/claim") return await claimSignInRequest(request, env);
      if (method === "GET" && path === "/approve") {
        const requestId = url.searchParams.get("request") ?? "";
        return approvePage({ requestId, machine: (await openSignInRequest(env, requestId))?.machine ?? null });
      }
      if (method === "POST" && path === "/login/options") return await loginOptions(request, env);
      if (method === "POST" && path === "/login/verify") return await loginVerify(request, env);

      // Browser routes, authenticated by the session cookie.
      if (method === "GET" && path === "/") {
        return (await hasSession(request, env)) ? dashboardPage(env.CF_VERSION_METADATA.id) : signInPage();
      }
      if (method === "POST" && path === "/logout") {
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": await endSession(request, env) } });
      }
      if (method === "POST" && path === "/dev/approve" && env.DEV_TOKEN) {
        // Local development only, as /dev/session: approves a sign-in request without a passkey, for the end-to-end test.
        if (url.searchParams.get("token") !== env.DEV_TOKEN) return json({ error: "unauthorized" }, 401);
        const machine = await approveSignInRequest(env, url.searchParams.get("request") ?? "");
        return machine === undefined ? json({ error: "no open request" }, 410) : json({ ok: true, machine });
      }
      if (method === "GET" && path === "/dev/session" && env.DEV_TOKEN) {
        if (url.searchParams.get("token") !== env.DEV_TOKEN) return json({ error: "unauthorized" }, 401);
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": devSessionCookie(env.DEV_TOKEN) } });
      }
      if (method === "GET" && path === "/dashboard/live") {
        // The cookie is SameSite=Strict, but a WebSocket handshake is checked by Origin as well, because
        // that is the one header a hostile page cannot forge from a browser.
        if (request.headers.get("origin") !== url.origin) return json({ error: "bad origin" }, 403);
        if (!(await hasSession(request, env))) return json({ error: "unauthorized" }, 401);
        return await toHub(env, request, "dashboard");
      }
      if (method === "GET" && path === "/dashboard/refinement-figures") {
        if (!(await hasSession(request, env))) return json({ error: "unauthorized" }, 401);
        const figures = await refinementFigures(env, url.searchParams.get("machine") ?? "", url.searchParams.get("workflow") ?? "");
        return figures === undefined ? json({ error: "no figures reported for that machine and workflow" }, 404) : json(figures);
      }

      const caller = await authorized(request, env);
      if (caller.kind === "unauthorized") return json({ error: "unauthorized" }, 401);
      if (caller.kind === "anotherMachine") return json(caller.refusal, MACHINE_MISMATCH_STATUS);
      const { machine } = caller;

      if (method === "GET" && path === "/daemon") return await toHub(env, request, "daemon", machine);
      if (method === "POST" && path === "/folders") return await registerFolders(request, env, machine);
      if (method === "GET" && path === "/files") return await listFiles(url, env);
      if (method === "GET" && path === "/skills") return await listSkills(env);
      if (method === "PUT" && path.startsWith("/skills/")) return await addSkill(path, env);
      if (method === "GET" && path.startsWith("/content/")) return await getContent(path, env);
      if (method === "PUT" && path === "/files") return await putFile(request, env, machine);
      if (method === "DELETE" && path === "/cli/token") return await revokeToken(request, env);
      return json({ error: "not found" }, 404);
    } catch (cause) {
      return json({ error: cause instanceof Error ? cause.message : String(cause) }, 500);
    }
  },
};

async function isClaimed(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

type Caller =
  | { readonly kind: "machine"; readonly machine: string }
  | { readonly kind: "unauthorized" }
  /** The token is valid but was issued to another machine than the one the daemon is configured as. */
  | { readonly kind: "anotherMachine"; readonly refusal: MachineMismatch };

/**
 * The machine a bearer token belongs to. The machine comes from the token's own row, never from the request,
 * so one machine's token cannot speak for another. The daemon names the machine it is configured as in
 * `MACHINE_HEADER`; when that is not the token's machine (a token file copied from another computer) the
 * request is refused and told whose token it is, rather than served as the token's machine, which would let
 * one computer silently overwrite another's folders and readings. Only the local-development token takes the
 * name from the header, since it belongs to no machine.
 */
async function authorized(request: Request, env: Env): Promise<Caller> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!presented) return { kind: "unauthorized" };
  const configured = request.headers.get(MACHINE_HEADER);
  if (env.DEV_TOKEN && presented === env.DEV_TOKEN) return { kind: "machine", machine: configured ?? "dev" };

  const row = await env.DB.prepare("SELECT token_hash, machine FROM device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(presented)).first<{ token_hash: string; machine: string }>();
  if (row === null) return { kind: "unauthorized" };
  if (configured !== row.machine) {
    return {
      kind: "anotherMachine",
      refusal: {
        error: `this token was issued to "${row.machine}", but the request comes from a machine configured as "${configured ?? "(none)"}"`,
        tokenMachine: row.machine,
      },
    };
  }

  // The dashboard shows last_seen only for a machine whose daemon is offline, and the hub stamps it when
  // a daemon disconnects; a daemon makes requests every minute or so, so writing each one is pointless.
  await env.DB.prepare("UPDATE device_tokens SET last_seen = ?1 WHERE token_hash = ?2 AND (last_seen IS NULL OR last_seen < ?1 - ?3)")
    .bind(Date.now(), row.token_hash, LAST_SEEN_INTERVAL_MS).run();
  return { kind: "machine", machine: row.machine };
}

/** How stale a token's last_seen may get while it is in use. */
const LAST_SEEN_INTERVAL_MS = 5 * 60_000;

/** One hub for the whole service: every machine and dashboard has to meet in the same place. */
const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("global"));

/** Tells the hub which tables a write changed, so open dashboards get a snapshot with the change. */
async function refreshDashboards(env: Env, tables: ReadonlyArray<SnapshotTable>): Promise<void> {
  await hub(env).fetch("https://hub/refresh", { method: "POST", body: JSON.stringify({ tables }) });
}

async function toHub(env: Env, request: Request, kind: "daemon" | "dashboard", machine?: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a WebSocket" }, 426);
  const headers = new Headers(request.headers);
  headers.set("x-hub-kind", kind);
  if (machine !== undefined) headers.set("x-hub-machine", machine);
  return await hub(env).fetch(new Request("https://hub/connect", { headers }));
}

/**
 * Records the folders and skills a machine found and answers with what it should sync.
 *
 * A folder seen for the first time starts off: nothing syncs into a folder until you tick it, so a folder
 * detected by mistake is never written to. One that exists keeps its checkbox. The skills reported
 * replace what was recorded for this machine, and are only shown on the dashboard: what syncs is the
 * synced list, the same for every folder.
 *
 * The daemon is the source of truth for what a machine has. A folder or skill it no longer reports is
 * deleted, so nothing is kept for things that no longer exist, and a folder that comes back is treated as new.
 *
 * Daemons report every few minutes and almost always report what they did last time, so only the
 * difference is written: rows no longer reported are deleted, new ones inserted, and a skill whose file
 * list changed updated. A report that changes nothing writes no rows and refreshes no dashboard.
 */
async function registerFolders(request: Request, env: Env, machine: string): Promise<Response> {
  const body = await request.json() as Partial<FoldersRequest>;
  const folders: FoldersRequest["folders"] = (Array.isArray(body.folders) ? body.folders : [])
    .filter((folder) => typeof folder?.path === "string" && Array.isArray(folder.skills));
  const reported = folders.flatMap((folder) => folder.skills.map((skill) => [folder.path, skill.name]));
  const now = Date.now();

  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM folders WHERE machine = ? AND path NOT IN (SELECT value FROM json_each(?))")
      .bind(machine, JSON.stringify(folders.map((folder) => folder.path))),
    env.DB.prepare(`DELETE FROM skills WHERE machine = ? AND NOT EXISTS (
                      SELECT 1 FROM json_each(?) AS reported
                      WHERE json_extract(reported.value, '$[0]') = skills.folder AND json_extract(reported.value, '$[1]') = skills.skill)`)
      .bind(machine, JSON.stringify(reported)),
    ...folders.flatMap((folder) => [
      env.DB.prepare(`INSERT INTO folders (machine, path, enabled, detected_at) VALUES (?, ?, 0, ?)
                      ON CONFLICT(machine, path) DO NOTHING`).bind(machine, folder.path, now),
      ...folder.skills.map((skill) => env.DB.prepare(`INSERT INTO skills (machine, folder, skill, files) VALUES (?, ?, ?, ?)
                                                       ON CONFLICT(machine, folder, skill) DO UPDATE SET files = excluded.files
                                                       WHERE files IS NOT excluded.files`)
        .bind(machine, folder.path, skill.name, JSON.stringify(skill.files))),
    ]),
  ]);

  if (results.some((result) => result.meta.changes > 0)) await refreshDashboards(env, ["folders", "skills"]);
  const response: FoldersResponse = { folders: await prefsFor(env, machine) };
  return json(response);
}

/** Everything after the caller's cursor, oldest first, so a partial apply can resume where it stopped. */
async function listFiles(url: URL, env: Env): Promise<Response> {
  const since = Number(url.searchParams.get("since") ?? 0);
  const { results } = await env.DB
    .prepare("SELECT path, hash, seq, edited_at, updated_by FROM files WHERE seq > ? ORDER BY seq ASC LIMIT 500")
    .bind(Number.isFinite(since) ? since : 0).all<FileRow>();

  const rows = results ?? [];
  const body: ListFilesResponse = {
    cursor: rows.length > 0 ? rows[rows.length - 1]!.seq : since,
    files: rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      editedAt: row.edited_at,
      updatedBy: row.updated_by,
    })),
  };
  return json(body);
}

/** The synced list with each skill's live file count and latest edit, for `skill-sync list`. */
/**
 * `PUT /skills/<name>`: puts a skill on the synced list, as ticking it on the dashboard does. For an agent
 * that has just written a skill, through `skill-sync add`. The daemon checks the skill's files before
 * asking; this only checks the name, since the files are not here yet.
 */
async function addSkill(path: string, env: Env): Promise<Response> {
  const skill = decodeURIComponent(path.slice("/skills/".length));
  if (!isSkillName(skill)) {
    return json({ error: `"${skill}" is not a skill name: lowercase letters and digits in hyphen-joined words, at most 64 characters` }, 400);
  }
  return await hub(env).fetch("https://hub/add-skill", { method: "POST", body: JSON.stringify({ skill }) });
}

async function listSkills(env: Env): Promise<Response> {
  const [list, files] = await env.DB.batch([
    env.DB.prepare("SELECT skill FROM synced_skills WHERE deleted_at IS NULL ORDER BY skill"),
    env.DB.prepare(`SELECT files.path, files.edited_at, COALESCE(machines.name, files.updated_by) AS edited_by
                    FROM files LEFT JOIN machines ON machines.machine = files.updated_by
                    WHERE files.hash IS NOT NULL`),
  ]);
  const bySkill = new Map<string, { path: string; edited_at: number; edited_by: string }[]>();
  for (const row of (files?.results ?? []) as { path: string; edited_at: number; edited_by: string }[]) {
    bySkill.set(skillOf(row.path), [...(bySkill.get(skillOf(row.path)) ?? []), row]);
  }
  const body: ListSkillsResponse = {
    skills: ((list?.results ?? []) as { skill: string }[]).map(({ skill }) => {
      const rows = bySkill.get(skill) ?? [];
      const latest = rows.reduce<(typeof rows)[number] | undefined>((a, b) => (a === undefined || b.edited_at > a.edited_at ? b : a), undefined);
      return { name: skill, files: rows.length, editedAt: latest?.edited_at ?? null, editedBy: latest?.edited_by ?? null };
    }),
  };
  return json(body);
}

async function getContent(path: string, env: Env): Promise<Response> {
  const object = await env.CONTENT.get(path.slice("/content/".length));
  if (object === null) return json({ error: "no such content" }, 404);
  return new Response(object.body, { headers: { "content-type": "application/octet-stream" } });
}

/**
 * Takes a write only if it was edited later than the version held. A refused write is answered 409 with
 * the version that won, which the daemon applies at once.
 */
async function putFile(request: Request, env: Env, machine: string): Promise<Response> {
  const body = await request.json() as Partial<PutFileRequest>;
  const { path, editedAt } = body;
  if (typeof path !== "string") {
    return json({ error: "path is required" }, 400);
  }
  if (typeof editedAt !== "number" || !Number.isFinite(editedAt)) {
    return json({ error: "editedAt is required; upgrade skill-sync with `skill-sync upgrade`" }, 400);
  }

  const badPath = invalidPathReason(path);
  if (badPath) return json({ error: `rejected path: ${badPath}` }, 400);

  const hash = typeof body.hash === "string" ? body.hash : null;
  const content = typeof body.content === "string" ? body.content : null;
  if (hash !== null && content === null) return json({ error: "content is required unless deleting" }, 400);

  if (hash !== null && content !== null) {
    const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
    // Content is addressed by hash, so storing it under a hash it does not have would hand every other
    // machine the wrong bytes under a name they trust. Only the server can check this.
    if (await sha256Bytes(bytes) !== hash) {
      return json({ error: "content does not match the hash it was sent under" }, 400);
    }
    await env.CONTENT.put(hash, bytes);
  }

  // The latest edit wins: the write lands only if it was edited later than the version held, decided in
  // one statement so two machines writing at once cannot both win. The counter lives in the table rather
  // than a separate row for the same reason.
  const result = await env.DB
    .prepare(`INSERT INTO files (path, hash, seq, updated_at, updated_by, edited_at)
              VALUES (?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM files), ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                hash = excluded.hash,
                seq = (SELECT IFNULL(MAX(seq), 0) + 1 FROM files),
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by,
                edited_at = excluded.edited_at
              WHERE excluded.edited_at > files.edited_at AND excluded.hash IS NOT files.hash`)
    .bind(path, hash, Date.now(), machine, Math.floor(editedAt)).run();

  if (result.meta.changes === 0) {
    const current = await env.DB.prepare("SELECT hash, edited_at FROM files WHERE path = ?")
      .bind(path).first<{ hash: string | null; edited_at: number }>();
    // Already the version held: nothing to change, and nothing for the sender to apply.
    if ((current?.hash ?? null) === hash) return json({ ok: true, unchanged: true });
    return json({ error: "a later edit is held", currentHash: current?.hash ?? null, currentEditedAt: current?.edited_at ?? 0 }, 409);
  }

  await markSkill(env, skillOf(path));
  // Every connected daemon syncs now rather than at its next poll — including the writer's, whose other
  // folders need the change too.
  await hub(env).fetch("https://hub/changed", { method: "POST" });
  return json({ ok: true });
}

/**
 * A skill whose last file was deleted is deleted: it leaves the list the dashboard shows, while staying
 * in the table so every daemon keeps syncing it and deletes its own copy. A file written to it again
 * brings it back.
 */
async function markSkill(env: Env, skill: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE synced_skills SET deleted_at = CASE
       WHEN EXISTS (SELECT 1 FROM files WHERE hash IS NOT NULL AND ${SKILL_OF_PATH} = ?1) THEN NULL
       ELSE COALESCE(deleted_at, ?2) END
     WHERE skill = ?1`,
  ).bind(skill, Date.now()).run();
  await refreshDashboards(env, ["files", "synced_skills"]);
}

/**
 * Revokes the token the caller presented.
 *
 * Deleting the local file is not revocation: a token copied off a machine before it was decommissioned
 * would otherwise keep working forever, and nothing here would ever notice.
 */
async function revokeToken(request: Request, env: Env): Promise<Response> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  await env.DB.prepare("DELETE FROM device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(presented)).run();
  await refreshDashboards(env, ["device_tokens"]);
  return json({ ok: true });
}
