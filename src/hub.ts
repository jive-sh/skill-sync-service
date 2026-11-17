import { DurableObject } from "cloudflare:workers";
import {
  DAEMON_VERSION_HEADER, skillOf, type AccountUsage, type AddSkillResponse, type MachineAccountReading, type DaemonMessage, type FileHash, type DashboardMessage, type FolderState, type HubToDaemon,
  type MachineView, type SkillView, type Snapshot, type SyncedSkill,
} from "@jive-sh/skill-sync";
import type { Env } from "./env";
import { prefsFor } from "./prefs";
import { accountsFrom, groupAccounts } from "./usage";

/**
 * The one place every live connection meets: each machine's daemon and each open dashboard.
 *
 * A daemon being connected *is* the machine being online — there is no heartbeat row to write and go
 * stale. Connections use the hibernation API, so an idle hub costs nothing while sockets stay open:
 * Cloudflare holds them and wakes this object only for a real message. Keepalive pings are answered by
 * the runtime without waking it at all.
 *
 * The worker authenticates every connection before handing it here and passes who it is in headers;
 * nothing in this object trusts the client to say which machine it is.
 */

/** `version` is what the daemon said it runs when it connected; absent from daemons before 0.4.6. */
type DaemonAttachment = {
  readonly kind: "daemon";
  readonly machine: string;
  readonly version?: string;
};
type Attachment = DaemonAttachment | { readonly kind: "dashboard" };

/** Where npm says which version is `latest`: the same dist-tag every daemon's auto-upgrade installs. */
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@jive-sh/skill-sync/dist-tags";
/** Snapshots go out on every change; npm is asked at most once a minute, and a release takes minutes to land. */
const PUBLISHED_TTL_MS = 60_000;
/** After a failed lookup, sooner than that, but not on every snapshot: each one would wait out the timeout. */
const PUBLISHED_RETRY_MS = 10_000;

/**
 * The tables a dashboard snapshot is built from, each with the query that reads it. Every write to one of
 * them names it (`invalidate` here, `POST /refresh` from the worker), and only those are read again: the
 * rest come from what the hub read last, so a status line changing does not re-read every file.
 */
const SNAPSHOT_QUERIES = {
  device_tokens: "SELECT machine, MAX(last_seen) AS last_seen FROM device_tokens GROUP BY machine",
  folders: "SELECT machine, path, enabled, state, detail, last_activity_at, last_activity FROM folders ORDER BY machine, path",
  skills: "SELECT machine, folder, skill, files FROM skills ORDER BY skill",
  files: "SELECT path, hash, updated_by, edited_at FROM files WHERE hash IS NOT NULL ORDER BY path",
  machines: "SELECT machine, name FROM machines",
  // Deleted skills stay in the table so daemons delete their copies, but are no longer on the list.
  synced_skills: "SELECT skill FROM synced_skills WHERE deleted_at IS NULL ORDER BY skill",
  account_readings: "SELECT machine, usage, reported_at FROM account_readings",
} as const;
export type SnapshotTable = keyof typeof SNAPSHOT_QUERIES;
const SNAPSHOT_TABLES = Object.keys(SNAPSHOT_QUERIES) as SnapshotTable[];
type TableRows = Record<SnapshotTable, ReadonlyArray<unknown>>;

interface FolderRow {
  readonly machine: string;
  readonly path: string;
  readonly enabled: number;
  readonly state: FolderState;
  readonly detail: string | null;
  readonly last_activity_at: number | null;
  readonly last_activity: string | null;
}

interface SkillRow {
  readonly machine: string;
  readonly folder: string;
  readonly skill: string;
  readonly files: string;
}

export class Hub extends DurableObject<Env> {
  /** The last answer from npm and when to ask again; kept in memory only, so a hub that wakes asks again. */
  private published: { readonly version: string | null; readonly nextCheckAt: number } = { version: null, nextCheckAt: 0 };
  /**
   * Each snapshot table's rows as last read, until a write to it drops them. Memory only, so a hub that
   * wakes from hibernation reads everything again. `generations` counts the drops, so a read that was
   * under way when its table changed is used once but not kept.
   */
  private cached: Partial<TableRows> = {};
  private readonly generations = new Map<SnapshotTable, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/changed") {
      this.toDaemons(undefined, { type: "changed" });
      return new Response(null, { status: 204 });
    }
    if (path === "/refresh") {
      const { tables } = await request.json() as { tables?: unknown };
      this.invalidate(Array.isArray(tables) ? SNAPSHOT_TABLES.filter((table) => tables.includes(table)) : SNAPSHOT_TABLES);
      await this.broadcast();
      return new Response(null, { status: 204 });
    }
    if (path === "/add-skill") {
      const { skill } = await request.json() as { skill: string };
      const response: AddSkillResponse = { added: await this.setSkill(skill, true) };
      return Response.json(response);
    }
    if (path === "/connect") return await this.accept(request);
    return new Response("not found", { status: 404 });
  }

  private async accept(request: Request): Promise<Response> {
    const kind = request.headers.get("x-hub-kind");
    const machine = request.headers.get("x-hub-machine");
    // Reported by the daemon itself and only ever displayed, so it is shortened rather than checked.
    const version = request.headers.get(DAEMON_VERSION_HEADER)?.slice(0, 64);
    const attachment: Attachment | undefined = kind === "dashboard" ? { kind: "dashboard" }
      : kind === "daemon" && machine ? { kind: "daemon", machine, ...(version ? { version } : {}) }
      : undefined;
    if (attachment === undefined) return new Response("bad connection", { status: 400 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, attachment.kind === "daemon" ? ["daemon", `machine:${attachment.machine}`] : ["dashboard"]);
    server.serializeAttachment(attachment);

    if (attachment.kind === "daemon") {
      // Preferences may have changed while this machine was away; it gets them before anything else.
      send(server, { type: "prefs", folders: await prefsFor(this.env, attachment.machine) });
      // A machine that just signed in has its first token row now.
      this.invalidate(["device_tokens"]);
      await this.broadcast();
    } else {
      // A page being opened reads everything, so nothing a write forgot to name can stay stale past a reload.
      this.invalidate(SNAPSHOT_TABLES);
      send(server, await this.snapshot());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Adds a skill to the synced list or takes it off: one list for every machine and folder. Adding one
   * already on the list changes nothing, so it can be repeated; returns false then, and true otherwise.
   *
   * The dashboard's checkbox and `skill-sync add` both land here, so the two cannot differ in what adding
   * a skill does. A skill whose files were all deleted is still in the table, marked deleted; adding it
   * again brings it back.
   */
  private async setSkill(skill: string, synced: boolean): Promise<boolean> {
    const before = await this.env.DB.prepare("SELECT deleted_at FROM synced_skills WHERE skill = ?")
      .bind(skill).first<{ deleted_at: number | null }>();
    if (synced && before !== null && before.deleted_at === null) return false;
    await (synced
      ? this.env.DB.prepare(`INSERT INTO synced_skills (skill, added_at) VALUES (?, ?)
                              ON CONFLICT(skill) DO UPDATE SET deleted_at = NULL`).bind(skill, Date.now())
      : this.env.DB.prepare("DELETE FROM synced_skills WHERE skill = ?").bind(skill)).run();
    this.invalidate(["synced_skills"]);
    // The list is the same for every machine, so every connected daemon gets it.
    for (const machine of this.connectedMachines()) {
      this.toDaemons(machine, { type: "prefs", folders: await prefsFor(this.env, machine) });
    }
    await this.broadcast();
    return true;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as unknown;

    if (attachment.kind === "daemon") {
      const status = message as DaemonMessage;
      if (status.type === "usage") {
        const usage = accountsFrom(status.accounts);
        const sent = Array.isArray(status.accounts) ? status.accounts.length : 0;
        // What was kept and dropped, so whether a daemon's accounts reach the dashboard shows in the logs.
        console.log(`usage from ${attachment.machine} (${attachment.version ?? "version unknown"}): ${usage.length} accounts kept, ${sent - usage.length} dropped; `
          + usage.map(describeUsage).join(", "));
        await this.saveUsage(attachment.machine, usage);
        this.invalidate(["account_readings"]);
        await this.broadcast();
        return;
      }
      if (status.type !== "status") return;
      await this.env.DB.prepare(
        `UPDATE folders SET state = ?, detail = ?,
           last_activity_at = CASE WHEN ? IS NULL THEN last_activity_at ELSE ? END,
           last_activity = COALESCE(?, last_activity)
         WHERE machine = ? AND path = ?`,
      ).bind(
        status.state, status.detail ?? null,
        status.activity ?? null, Date.now(), status.activity ?? null,
        attachment.machine, status.folder,
      ).run();
      this.invalidate(["folders"]);
      await this.broadcast();
      return;
    }

    const change = message as DashboardMessage;
    if (change.type === "setFolder") {
      await this.env.DB.prepare("UPDATE folders SET enabled = ? WHERE machine = ? AND path = ?")
        .bind(change.enabled ? 1 : 0, change.machine, change.path).run();
      this.invalidate(["folders"]);
      this.toDaemons(change.machine, { type: "prefs", folders: await prefsFor(this.env, change.machine) });
    } else if (change.type === "setSkill") {
      await this.setSkill(change.skill, change.synced);
      return;
    } else if (change.type === "renameMachine") {
      // A name is display only, so nothing goes to the daemon; an empty one restores the machine name.
      const name = change.name.trim().slice(0, 80);
      await (name === "" || name === change.machine
        ? this.env.DB.prepare("DELETE FROM machines WHERE machine = ?").bind(change.machine)
        : this.env.DB.prepare("INSERT INTO machines (machine, name) VALUES (?, ?) ON CONFLICT(machine) DO UPDATE SET name = excluded.name")
          .bind(change.machine, name)).run();
      this.invalidate(["machines"]);
      await this.broadcast();
      return;
    } else {
      return;
    }
    await this.broadcast();
  }

  /**
   * The machine's latest reading of each account, replacing the last one; a folder it no longer sends is
   * gone from the machine, so its row goes too.
   */
  private async saveUsage(machine: string, usage: ReadonlyArray<AccountUsage>): Promise<void> {
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM account_readings WHERE machine = ? AND home NOT IN (SELECT value FROM json_each(?))")
        .bind(machine, JSON.stringify(usage.map((account) => account.home))),
      ...usage.map((account) => this.env.DB.prepare(
        `INSERT INTO account_readings (machine, home, usage, reported_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(machine, home) DO UPDATE SET usage = excluded.usage, reported_at = excluded.reported_at`,
      ).bind(machine, account.home, JSON.stringify(account), now)),
    ]);
  }

  private connectedMachines(): Set<string> {
    return new Set(this.ctx.getWebSockets("daemon")
      .map((ws) => (ws.deserializeAttachment() as DaemonAttachment).machine));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed; nothing to answer.
    }
    await this.disconnected(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnected(ws);
  }

  /**
   * A daemon going offline is when its machine was last seen: the moment is stamped on the token it last
   * used, since the worker writes last_seen only every few minutes while a daemon is connected.
   */
  private async disconnected(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.kind === "daemon") {
      await this.env.DB.prepare(`UPDATE device_tokens SET last_seen = ?1 WHERE token_hash =
                                   (SELECT token_hash FROM device_tokens WHERE machine = ?2 ORDER BY last_seen DESC LIMIT 1)`)
        .bind(Date.now(), attachment.machine).run();
      this.invalidate(["device_tokens"]);
    }
    await this.broadcast(ws);
  }

  private invalidate(tables: ReadonlyArray<SnapshotTable>): void {
    for (const table of tables) {
      delete this.cached[table];
      this.generations.set(table, (this.generations.get(table) ?? 0) + 1);
    }
  }

  /** Every snapshot table's rows: the cached ones as they are, the rest read in one batch. */
  private async tableRows(): Promise<TableRows> {
    const cached = { ...this.cached };
    const missing = SNAPSHOT_TABLES.filter((table) => cached[table] === undefined);
    if (missing.length === 0) return cached as TableRows;
    const started = new Map(missing.map((table) => [table, this.generations.get(table) ?? 0]));
    const results = await this.env.DB.batch(missing.map((table) => this.env.DB.prepare(SNAPSHOT_QUERIES[table])));
    const read: Partial<TableRows> = {};
    missing.forEach((table, index) => {
      read[table] = results[index]?.results ?? [];
      if (this.generations.get(table) === started.get(table)) this.cached[table] = read[table];
    });
    return { ...cached, ...read } as TableRows;
  }

  private toDaemons(machine: string | undefined, message: HubToDaemon): void {
    for (const ws of this.ctx.getWebSockets(machine === undefined ? "daemon" : `machine:${machine}`)) send(ws, message);
  }

  /** `closing` is excluded: during its close handler a socket can still be listed. */
  private async broadcast(closing?: WebSocket): Promise<void> {
    const dashboards = this.ctx.getWebSockets("dashboard").filter((ws) => ws !== closing);
    if (dashboards.length === 0) return;
    const snapshot = await this.snapshot(closing);
    for (const ws of dashboards) send(ws, snapshot);
  }

  private async snapshot(closing?: WebSocket): Promise<Snapshot> {
    // Each online machine with what its daemon reported on its connection.
    const online = new Map(
      this.ctx.getWebSockets("daemon")
        .filter((ws) => ws !== closing && ws.readyState === WebSocket.OPEN)
        .map((ws) => ws.deserializeAttachment() as DaemonAttachment)
        .map((attachment) => [attachment.machine, attachment] as const),
    );
    const { device_tokens: tokens, folders, skills, files, machines: renamed, synced_skills: list, account_readings: readings } = await this.tableRows();
    const accountReadings: MachineAccountReading[] = (readings as { machine: string; usage: string; reported_at: number }[])
      .map((row) => ({ machine: row.machine, reportedAt: row.reported_at, usage: JSON.parse(row.usage) as AccountUsage }));
    const syncedList = (list as { skill: string }[]).map((row) => row.skill);
    const onList = new Set(syncedList);
    const names = new Map((renamed as { machine: string; name: string }[]).map((row) => [row.machine, row.name]));

    const lastSeen = new Map((tokens as { machine: string; last_seen: number | null }[])
      .map((row) => [row.machine, row.last_seen]));
    const folderRows = folders as FolderRow[];
    const skillRows = skills as SkillRow[];
    const machineNames = [...new Set([
      ...lastSeen.keys(), ...folderRows.map((row) => row.machine), ...accountReadings.map((row) => row.machine), ...online.keys(),
    ])].sort();

    const machines: MachineView[] = machineNames.map((machine) => ({
      machine,
      name: names.get(machine) ?? machine,
      online: online.has(machine),
      daemonVersion: online.get(machine)?.version ?? null,
      lastSeen: lastSeen.get(machine) ?? null,
      folders: folderRows.filter((row) => row.machine === machine).map((row) => ({
        path: row.path,
        enabled: row.enabled === 1,
        state: row.state,
        detail: row.detail,
        lastActivityAt: row.last_activity_at,
        lastActivity: row.last_activity,
        skills: folderSkills(skillRows.filter((skill) => skill.machine === machine && skill.folder === row.path), syncedList, onList),
      })),
    }));

    const synced = new Map<string, SyncedSkill["files"][number][]>();
    for (const row of files as { path: string; hash: string; updated_by: string; edited_at: number }[]) {
      const name = skillOf(row.path);
      synced.set(name, [...(synced.get(name) ?? []), { path: row.path, hash: row.hash, updatedBy: row.updated_by, editedAt: row.edited_at }]);
    }
    // Every machine name the page can show — machine headers and "changed by" — mapped once.
    const everyName = new Set([...machineNames, ...[...synced.values()].flat().map((file) => file.updatedBy)]);
    return {
      type: "snapshot",
      version: this.env.CF_VERSION_METADATA.id,
      publishedVersion: await this.publishedVersion(),
      names: Object.fromEntries([...everyName].map((machine) => [machine, names.get(machine) ?? machine])),
      skills: syncedList.map((name) => ({ name, files: synced.get(name) ?? [] })),
      machines,
      accounts: groupAccounts(accountReadings),
    };
  }

  /** npm's `latest`. A failed lookup keeps the last answer it had. */
  private async publishedVersion(): Promise<string | null> {
    if (Date.now() < this.published.nextCheckAt) return this.published.version;
    try {
      const response = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`${response.status}`);
      const latest = (await response.json() as Record<string, unknown>)["latest"];
      this.published = { version: typeof latest === "string" ? latest : null, nextCheckAt: Date.now() + PUBLISHED_TTL_MS };
    } catch {
      this.published = { ...this.published, nextCheckAt: Date.now() + PUBLISHED_RETRY_MS };
    }
    return this.published.version;
  }
}

/** One account in the log: its limits, and why a figure is missing or old, so a gap on the page can be traced. */
function describeUsage(account: AccountUsage): string {
  const { limits, local } = account;
  const limitsText = limits.state === "reading"
    ? `limits ${limits.source}${limits.cliFailure === undefined ? "" : ` (${limits.cliFailure})`}`
    : `limits ${limits.state} (${limits.reason})`;
  const who = account.identity === null ? "unidentified" : account.identity.email;
  return `${account.tool} ${account.home} ${who} ${limitsText} local ${local.state}${local.state === "unknown" ? ` (${local.reason})` : ""}`;
}

function send(ws: WebSocket, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // A socket that closed mid-broadcast; its close handler sends the next snapshot.
  }
}

/** A folder's skills on disk, plus each listed skill it does not have yet, which its daemon will pull. */
function folderSkills(rows: ReadonlyArray<SkillRow>, list: ReadonlyArray<string>, onList: ReadonlySet<string>): SkillView[] {
  const local = new Set(rows.map((row) => row.skill));
  return [
    ...rows.map((row) => ({ name: row.skill, synced: onList.has(row.skill), local: true, files: parseFiles(row.files) })),
    ...list.filter((skill) => !local.has(skill)).map((skill) => ({ name: skill, synced: true, local: false, files: [] })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Daemons before 0.2.1 reported bare paths; a row from one shows without a hash until it re-registers. */
function parseFiles(json: string): FileHash[] {
  return (JSON.parse(json) as (string | FileHash)[])
    .map((file) => (typeof file === "string" ? { path: file, hash: "" } : file));
}
