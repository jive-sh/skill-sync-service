/**
 * End-to-end check of skill-sync against a local copy of this service, using the daemon's real sync code.
 *
 *   bunx wrangler d1 execute jive-skill-sync-db --local --persist-to .e2e/state --file src/schema.sql
 *   bunx wrangler dev --port 8799 --local --persist-to .e2e/state --var DEV_TOKEN:devtok
 *   bun test/e2e.ts
 *
 * Start from an empty state directory every run: the checks assume a fresh database, and a second run
 * against the first run's rows fails checks that have nothing to do with the change being tested.
 *
 * Two machines, A and B, each with one skills folder, plus a dashboard connection to tick skills.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SS = join(import.meta.dir, "../../skill-sync/src/internal");
const { syncOnce } = await import(`${SS}/sync.ts`);
const { localSkills } = await import(`${SS}/folders.ts`);
const { DAEMON_VERSION_HEADER } = await import(`${SS}/wire.ts`);

const E = "http://localhost:8799";
const T = "devtok";
const root = join(import.meta.dir, "../.e2e/folders");
rmSync(root, { recursive: true, force: true });
const folders = { A: `${root}/a/skills`, B: `${root}/b/skills` } as const;
type Machine = keyof typeof folders;
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });

const cfg = (machine: Machine) => ({ endpoint: E, token: T, machine, exclude: [] as string[] });
const headers = (machine: string) => ({ authorization: `Bearer ${T}`, "x-skill-sync-machine": machine, "content-type": "application/json" });
const states = { A: { cursor: 0, known: {} }, B: { cursor: 0, known: {} } } as Record<Machine, { cursor: number; known: Record<string, string> }>;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function register(machine: Machine): Promise<string[]> {
  const folder = folders[machine];
  const response = await fetch(`${E}/folders`, {
    method: "POST", headers: headers(machine),
    body: JSON.stringify({ folders: [{ path: folder, skills: localSkills(folder, cfg(machine)) }] }),
  });
  return (await response.json()).folders[0].skills;
}
async function sync(machine: Machine) {
  return await syncOnce(cfg(machine), folders[machine], states[machine], new Set(await register(machine)));
}
const read = (machine: Machine, path: string) => existsSync(join(folders[machine], path)) ? readFileSync(join(folders[machine], path), "utf8") : undefined;
/** Writes a file with an explicit edit time, so "later" does not depend on how fast the test runs. */
function edit(machine: Machine, path: string, text: string, at: number) {
  const file = join(folders[machine], path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, new Date(at), new Date(at));
}
async function sha256(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
async function serverFiles() {
  return (await (await fetch(`${E}/files?since=0`, { headers: headers("A") })).json()).files as { path: string; hash: string | null; editedAt: number }[];
}

const cookie = (await fetch(`${E}/dev/session?token=${T}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
const snapshots: any[] = [];
const dashboard = new WebSocket(`${E.replace("http", "ws")}/dashboard/live`, { headers: { cookie, origin: E } } as any);
dashboard.onmessage = (event) => snapshots.push(JSON.parse(event.data as string));
await new Promise((resolve) => (dashboard.onopen = resolve));
const tick = async (skill: string, synced: boolean) => {
  dashboard.send(JSON.stringify({ type: "setSkill", skill, synced }));
  await Bun.sleep(500);
};

const t0 = Date.now() - 3_600_000;

// Folders are opt-in: a folder seen for the first time syncs nothing until it is ticked.
const firstPrefs = await (await fetch(`${E}/folders`, {
  method: "POST", headers: headers("A"),
  body: JSON.stringify({ folders: [{ path: folders.A, skills: [] }] }),
})).json();
check("a folder seen for the first time starts unticked", firstPrefs.folders.length === 0, firstPrefs);
await fetch(`${E}/folders`, { method: "POST", headers: headers("B"), body: JSON.stringify({ folders: [{ path: folders.B, skills: [] }] }) });
for (const machine of ["A", "B"] as const) {
  dashboard.send(JSON.stringify({ type: "setFolder", machine, path: folders[machine], enabled: true }));
}
await Bun.sleep(500);

// One machine saving repeatedly: the case that used to report a conflict on every save.
edit("A", "foo/SKILL.md", "v1", t0);
check("a skill off the list is not pushed", (await sync("A")).pushed.length === 0);
await tick("foo", true);
check("A pushes foo once it is on the list", (await sync("A")).pushed.includes("foo/SKILL.md"));
edit("A", "foo/SKILL.md", "v2", t0 + 1000);
let report = await sync("A");
check("A saving again pushes v2, with no revert", report.pushed.includes("foo/SKILL.md") && read("A", "foo/SKILL.md") === "v2", report);
edit("A", "foo/SKILL.md", "v3", t0 + 2000);
report = await sync("A");
check("A saving a third time pushes v3", report.pushed.includes("foo/SKILL.md") && read("A", "foo/SKILL.md") === "v3", report);
report = await sync("B");
check("B pulls v3", read("B", "foo/SKILL.md") === "v3", report);
report = await sync("B");
check("B's next cycle changes nothing (a pull is not mistaken for an edit)", report.pushed.length === 0 && report.pulled.length === 0, report);

// Two machines edit the same file: the later edit wins everywhere, whichever syncs first.
edit("A", "foo/SKILL.md", "A at +10s", t0 + 10_000);
edit("B", "foo/SKILL.md", "B at +20s", t0 + 20_000);
await sync("A");
report = await sync("B");
check("B's later edit replaces A's on the server", report.pushed.includes("foo/SKILL.md"), report);
await sync("A");
check("A takes B's later edit", read("A", "foo/SKILL.md") === "B at +20s");

edit("A", "foo/SKILL.md", "A at +40s", t0 + 40_000);
edit("B", "foo/SKILL.md", "B at +30s", t0 + 30_000);
await sync("B");
check("B's edit goes up first", (await serverFiles()).find((f) => f.path === "foo/SKILL.md")?.editedAt === t0 + 30_000);
await sync("A");
await sync("B");
check("A's later edit wins even though it synced second", read("A", "foo/SKILL.md") === "A at +40s" && read("B", "foo/SKILL.md") === "A at +40s");

// A file restored with an old modification time loses to the server at once, rather than retrying forever.
edit("B", "foo/SKILL.md", "restored, edited long ago", t0 - 60_000);
report = await sync("B");
check("an older edit is replaced by the server's version in the same cycle", read("B", "foo/SKILL.md") === "A at +40s", report);

// No special files: a .local file is just a file of the skill.
edit("A", "foo/notes.local", "plain file", t0 + 50_000);
await sync("A");
await sync("B");
check(".local files sync like any other file", read("B", "foo/notes.local") === "plain file");

// Deleting a synced skill deletes it everywhere and takes it off the list.
rmSync(join(folders.A, "foo"), { recursive: true });
report = await sync("A");
check("A sends the deletion of every file", report.pushed.includes("foo/SKILL.md (deleted)") && report.pushed.includes("foo/notes.local (deleted)"), report);
await Bun.sleep(300);
check("foo leaves the list on the dashboard", !snapshots.at(-1).skills.some((s: any) => s.name === "foo"), snapshots.at(-1).skills);
report = await sync("B");
check("B deletes its copy, directory and all", !existsSync(join(folders.B, "foo")), report);
check("A does not bring it back", (await sync("A")).pulled.length === 0 && !existsSync(join(folders.A, "foo")));

// Unticking leaves every copy where it is and stops syncing.
edit("A", "bar/SKILL.md", "bar v1", t0 + 60_000);
await tick("bar", true);
await sync("A");
await sync("B");
await tick("bar", false);
edit("B", "bar/SKILL.md", "bar edited after unticking", t0 + 70_000);
report = await sync("B");
check("after unticking, an edit is not pushed", report.pushed.length === 0, report);
check("after unticking, both copies stay", read("A", "bar/SKILL.md") === "bar v1" && read("B", "bar/SKILL.md") === "bar edited after unticking");

// Lock names never sync: a .lock file an older daemon put on the server is not written to disk.
await fetch(`${E}/files`, {
  method: "PUT", headers: headers("A"),
  body: JSON.stringify({ path: "qux/held.lock", hash: await sha256("lock"), content: btoa("lock"), machine: "A", editedAt: t0 + 80_000 }),
});
await tick("qux", true);
report = await sync("B");
check("a .lock file on the server is never written to disk", read("B", "qux/held.lock") === undefined && !report.pulled.includes("qux/held.lock"), report);
await tick("qux", false);

// The list `skill-sync list` shows: ticked skills only, never deleted or unticked ones.
await tick("bar", true);
await tick("baz", true);
const listed = (await (await fetch(`${E}/skills`, { headers: headers("A") })).json()).skills;
check("GET /skills lists exactly the ticked skills", JSON.stringify(listed.map((s: any) => s.name)) === '["bar","baz"]', listed);
check("a listed skill reports its files and latest edit", listed[0].files === 1 && listed[0].editedAt === t0 + 60_000 && listed[0].editedBy === "A", listed[0]);
check("a skill ticked before any push has no files yet", listed[1].files === 0 && listed[1].editedAt === null, listed[1]);
check("GET /skills needs a token", (await fetch(`${E}/skills`)).status === 401);

// A daemon from before this change cannot write with its old rules.
const old = await fetch(`${E}/files`, {
  method: "PUT", headers: headers("A"),
  body: JSON.stringify({ path: "x/SKILL.md", baseHash: null, hash: null, content: null, machine: "A" }),
});
check("a write without editedAt is refused with an upgrade message", old.status === 400 && (await old.text()).includes("upgrade"));

// Versions: npm's latest at the top, and each connected daemon's own; an old daemon that sends none still connects.
const daemon = async (machine: string, version?: string) => {
  const ws = new WebSocket(`${E.replace("http", "ws")}/daemon`, {
    headers: { ...headers(machine), ...(version === undefined ? {} : { [DAEMON_VERSION_HEADER]: version }) },
  } as any);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return ws;
};
const machineView = (machine: string) => snapshots.at(-1).machines.find((m: any) => m.machine === machine);
const daemonA = await daemon("A", "0.0.1");
const daemonB = await daemon("B");
await Bun.sleep(500);
check("the snapshot carries npm's latest version", /^\d+\.\d+\.\d+/.test(snapshots.at(-1).publishedVersion ?? ""), snapshots.at(-1).publishedVersion);
check("a daemon's reported version is shown", machineView("A")?.online === true && machineView("A")?.daemonVersion === "0.0.1", machineView("A"));
check("a daemon that reports no version connects, version unknown", machineView("B")?.online === true && machineView("B")?.daemonVersion === null, machineView("B"));

// Account usage: each machine's latest reading per account is stored, malformed entries are dropped, the same account
// on two machines is one entry, and an offline machine's readings stay.
const accounts = () => snapshots.at(-1).accounts as any[];
const account = (tool: string, kind: string, value: string) => accounts().find((a) => a.tool === tool && a.key.kind === kind && (a.key.email ?? a.key.id ?? a.key.home) === value);
check("a daemon that has sent no usage shows no accounts", JSON.stringify(accounts()) === "[]", accounts());
const fromCli = {
  tool: "claude", home: ".claude-work", identity: { id: "org-1", email: "work@example.com", plan: "max" },
  limits: { state: "reading", asOf: t0, source: "account", windows: [
    { name: "5-hour", minutes: 300, usedPercent: 48, resetsAt: t0 + 3_600_000 },
    { name: "weekly Fable", minutes: 10080, usedPercent: 0, resetsAt: null },
  ] },
  local: { state: "spend", asOf: t0, periodDays: 30, spent: { amountMinor: 87488, currency: "USD", exponent: 2 }, sessions: 67, partial: false, provider: null },
};
const bedrock = {
  tool: "claude", home: ".claude-bedrock", identity: null, limits: { state: "none", reason: "Amazon Bedrock has no plan limits" },
  local: { state: "spend", asOf: t0, periodDays: 30, spent: { amountMinor: 475, currency: "USD", exponent: 2 }, sessions: 2, partial: false, provider: "bedrock" },
};
const codexSaved = {
  tool: "codex", home: ".codex-team", identity: null,
  limits: { state: "reading", asOf: 1793019227405, source: "saved", cliFailure: "`codex` was not found", windows: [{ name: "5-hour", minutes: 300, usedPercent: 24, resetsAt: null }],
    spent: { used: { amountMinor: 100, currency: "USD", exponent: 2 }, limit: null } },
  local: { state: "tokens", periodDays: 30, count: 288165427, sessions: 3 },
};
const grokSpend = {
  tool: "grok", home: ".grok", identity: null, limits: { state: "none", reason: "only in Grok's interactive /usage" },
  local: { state: "spend", asOf: 1793019227405, periodDays: 30, spent: { amountMinor: 137, currency: "USD", exponent: 2 }, sessions: 1, partial: false, provider: null },
};
const unknownCodex = { tool: "codex", home: ".codex", identity: null, limits: { state: "unknown", reason: "Codex's rate-limit record changed shape" }, local: { state: "none" } };
daemonA.send(JSON.stringify({ type: "usage", accounts: [
  fromCli,
  bedrock,
  unknownCodex,
  codexSaved,
  grokSpend,
  // The shape daemons before 0.5.0 sent.
  { tool: "claude", home: ".claude-old", state: "reading", asOf: t0, windows: [{ minutes: 300, usedPercent: 48, resetsAt: null }] },
  { ...fromCli, home: ".claude-bad-asof", limits: { ...fromCli.limits, asOf: "yesterday" } },
  { ...fromCli, home: ".claude-bad-source", limits: { ...fromCli.limits, source: "guess" } },
  { ...fromCli, home: ".claude-bad-identity", identity: { id: 1, email: "x", plan: null } },
  { ...codexSaved, home: ".codex-bad-tokens", local: { ...codexSaved.local, count: "lots" } },
  { ...bedrock, home: ".claude-bad-provider", local: { ...bedrock.local, provider: "vertex" } },
  { tool: "gemini", home: ".gemini", identity: null, limits: { state: "none", reason: "" }, local: { state: "none" } },
] }));
await Bun.sleep(500);
const sentByA = () => accounts().flatMap((a) => a.machines).filter((m: any) => m.machine === "A").map((m: any) => m.usage);
check("a daemon's accounts are kept, malformed and old-shape entries dropped",
  Bun.deepEquals(sentByA().sort((a: any, b: any) => a.home.localeCompare(b.home)), [bedrock, fromCli, unknownCodex, codexSaved, grokSpend].sort((a, b) => a.home.localeCompare(b.home))), sentByA());
check("an account its tool names is keyed by email", account("claude", "email", "work@example.com")?.machines.length === 1, accounts());
check("an account its tool cannot name is one folder on one machine, unidentified",
  account("grok", "unidentified", ".grok")?.key.machine === "A" && account("claude", "unidentified", ".claude-bedrock")?.tool === "claude", accounts());

// The same account on machine B, read later and in another folder: one entry, B's newer limits, both machines' use added.
const fromCliOnB = {
  ...fromCli, home: ".claude",
  limits: { ...fromCli.limits, asOf: t0 + 60_000, windows: [{ name: "5-hour", minutes: 300, usedPercent: 60, resetsAt: t0 + 3_600_000 }] },
  local: { ...fromCli.local, asOf: t0 + 60_000, spent: { amountMinor: 12_512, currency: "USD", exponent: 2 }, sessions: 3 },
};
const unreadableOnB = { ...codexSaved, identity: { id: "dev@example.com", email: "dev@example.com", plan: null }, home: ".codex", local: { state: "unknown", reason: "could not read" } };
const tokensOnA = { ...codexSaved, identity: { id: "dev@example.com", email: "dev@example.com", plan: null }, home: ".codex-dev" };
daemonB.send(JSON.stringify({ type: "usage", accounts: [fromCliOnB, unreadableOnB] }));
daemonA.send(JSON.stringify({ type: "usage", accounts: [fromCli, bedrock, unknownCodex, codexSaved, grokSpend, tokensOnA] }));
await Bun.sleep(500);
const work = account("claude", "email", "work@example.com");
check("the same email on two machines is one account, listing both", Bun.deepEquals(work?.machines.map((m: any) => m.machine), ["A", "B"]), work);
check("its limits are the freshest reading", work?.limits.asOf === t0 + 60_000 && work?.limits.windows[0].usedPercent === 60, work?.limits);
check("its local use is both machines' added up", work?.localTotal.state === "spend" && work?.localTotal.spent.amountMinor === 87488 + 12_512
  && work?.localTotal.sessions === 70 && work?.localTotal.partial === false, work?.localTotal);
const dev = account("codex", "email", "dev@example.com");
check("a machine whose use could not be read makes the total a lower bound", dev?.localTotal.state === "tokens" && dev?.localTotal.count === codexSaved.local.count
  && dev?.localTotal.partial === true, dev?.localTotal);
check("each machine's reading says when it was sent", work?.machines.every((m: any) => typeof m.reportedAt === "number" && m.reportedAt >= t0), work?.machines);

daemonA.close();
await Bun.sleep(500);
check("an offline machine shows no version", machineView("A")?.online === false && machineView("A")?.daemonVersion === null, machineView("A"));
check("an offline machine's readings stay", account("grok", "unidentified", ".grok")?.machines[0].usage.local.spent.amountMinor === 137
  && account("claude", "email", "work@example.com")?.machines.length === 2, accounts());

// A folder a machine stops sending is gone from it.
daemonB.send(JSON.stringify({ type: "usage", accounts: [fromCliOnB] }));
await Bun.sleep(500);
check("a folder a daemon stops sending is deleted", Bun.deepEquals(account("codex", "email", "dev@example.com")?.machines.map((m: any) => m.machine), ["A"]), accounts());
daemonB.close();

// `skill-sync add`: an agent puts a skill on the synced list without the dashboard.
const addSkill = (skill: string) => fetch(`${E}/skills/${encodeURIComponent(skill)}`, { method: "PUT", headers: headers("A") });
const syncedNames = async () => ((await (await fetch(`${E}/skills`, { headers: headers("A") })).json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
const first = await addSkill("agent-added");
check("PUT /skills/<name> adds a skill to the list", first.status === 200 && (await first.json() as { added: boolean }).added === true && (await syncedNames()).includes("agent-added"));
const again = await addSkill("agent-added");
check("adding it again changes nothing", again.status === 200 && (await again.json() as { added: boolean }).added === false);
const bad = await addSkill("Not_A_Skill");
check("a name that is not a skill name is refused", bad.status === 400 && !(await syncedNames()).includes("Not_A_Skill"));
const anonymous = await fetch(`${E}/skills/agent-added`, { method: "PUT" });
check("adding needs a machine token", anonymous.status === 401);
await tick("agent-added", false);
check("the dashboard can still untick it", !(await syncedNames()).includes("agent-added"));

// A folder report writes only what changed: a report that changes nothing reaches no dashboard, and every
// kind of change (a new skill, a changed file list, a skill or folder gone) still does.
const reportC = async (folderList: { path: string; skills: { name: string; files: { path: string; hash: string }[] }[] }[]) => {
  await fetch(`${E}/folders`, { method: "POST", headers: headers("C"), body: JSON.stringify({ folders: folderList }) });
  await Bun.sleep(500);
};
const localOnC = (path: string) => (machineView("C")?.folders.find((f: any) => f.path === path)?.skills ?? [])
  .filter((s: any) => s.local).map((s: any) => ({ name: s.name, files: s.files }));
const x1 = { name: "x", files: [{ path: "x/SKILL.md", hash: "h1" }] };
const y1 = { name: "y", files: [{ path: "y/SKILL.md", hash: "h1" }] };
await reportC([{ path: "/c/one", skills: [x1, y1] }, { path: "/c/two", skills: [x1] }]);
check("a new machine's skills reach the dashboard", Bun.deepEquals(localOnC("/c/one"), [x1, y1]) && Bun.deepEquals(localOnC("/c/two"), [x1]), machineView("C"));
const before = snapshots.length;
await reportC([{ path: "/c/one", skills: [x1, y1] }, { path: "/c/two", skills: [x1] }]);
check("reporting the same skills again sends no snapshot", snapshots.length === before, snapshots.length - before);
const x2 = { name: "x", files: [{ path: "x/SKILL.md", hash: "h2" }, { path: "x/more.md", hash: "h3" }] };
await reportC([{ path: "/c/one", skills: [x2] }, { path: "/c/two", skills: [x1] }]);
check("a changed file list replaces the old one and a skill no longer reported is gone",
  Bun.deepEquals(localOnC("/c/one"), [x2]) && Bun.deepEquals(localOnC("/c/two"), [x1]), machineView("C"));
await reportC([{ path: "/c/one", skills: [x2] }]);
check("a folder no longer reported is gone", Bun.deepEquals(machineView("C")?.folders.map((f: any) => f.path), ["/c/one"]), machineView("C"));
await reportC([{ path: "/c/one", skills: [x2] }, { path: "/c/two", skills: [] }]);
check("a folder that comes back is new: unticked, its old skills gone", Bun.deepEquals(localOnC("/c/two"), [])
  && machineView("C")?.folders.find((f: any) => f.path === "/c/two")?.enabled === false, machineView("C"));

dashboard.close();
console.log(failed === 0 ? "all passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
