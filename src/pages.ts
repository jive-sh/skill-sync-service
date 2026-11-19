/**
 * The pages a browser sees: passkey registration, sign-in (for a machine or for the dashboard), and the
 * dashboard itself.
 *
 * Served inline rather than from a bundle: they are a few hundred lines of glue, and a build step for
 * that would be more machinery than the thing it builds. They use the browser's own WebAuthn and
 * WebSocket APIs directly, so there is no client library to ship or keep current.
 */

/**
 * The page scripts below live inside template literals, so every backslash meant for the browser is
 * written twice: `/^(\\d+)/` here reaches the page as `/^(\d+)/`. A single one is eaten by TypeScript.
 */

/** Never cached: after a deploy, a reload must get the new page, not a stored copy of the old one. */
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

const shell = (title: string, body: string, script: string): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#111}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}}
 button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}
 #status{margin-top:1rem;opacity:.75}
</style></head><body>${body}<script type="module">${script}</script></body></html>`,
    { headers: HTML_HEADERS },
  );

/** base64url is what WebAuthn speaks; the browser APIs want ArrayBuffers. */
const CODEC = `
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const bytesToB64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const say = (m) => { document.getElementById("status").textContent = m; };
/** One passkey ceremony. With a sign-in request, it approves that machine; either way the response sets this
 *  browser's dashboard session. */
const signIn = async (request) => {
  say("Requesting options…");
  const options = await (await fetch("/login/options", { method: "POST" })).json();
  if (options.error) throw new Error(options.error);
  const challenge = options.challenge;
  options.challenge = b64urlToBytes(challenge);
  for (const c of options.allowCredentials ?? []) c.id = b64urlToBytes(c.id);
  say("Waiting for your authenticator…");
  const assertion = await navigator.credentials.get({ publicKey: options });
  const payload = {
    id: assertion.id,
    rawId: bytesToB64url(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: bytesToB64url(assertion.response.clientDataJSON),
      authenticatorData: bytesToB64url(assertion.response.authenticatorData),
      signature: bytesToB64url(assertion.response.signature),
      userHandle: assertion.response.userHandle ? bytesToB64url(assertion.response.userHandle) : null,
    },
    clientExtensionResults: assertion.getClientExtensionResults(),
  };
  const result = await (await fetch("/login/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: payload, challenge, ...(request === undefined ? {} : { request }) }),
  })).json();
  if (result.error) throw new Error(result.error);
  return result;
};
`;

/** `claimed` is read from the database, so the page cannot tell you registration is open when it is shut. */
export const registerPage = (claimed: boolean): Response => claimed
  ? shell(
      "Already claimed",
      `<h1>Already claimed</h1>
       <p>A passkey is registered, so registration is closed. Run <code>skill-sync login</code> to
       authorise this machine.</p>`,
      "",
    )
  : shell(
  "Register a passkey",
  `<h1>Claim skill sync</h1>
   <p>No passkey is registered yet. Creating one here claims this service; registration then closes.</p>
   <button id="go">Create passkey</button><p id="status"></p>`,
  `${CODEC}
document.getElementById("go").onclick = async () => {
  try {
    say("Requesting options…");
    const options = await (await fetch("/register/options", { method: "POST" })).json();
    if (options.error) return say(options.error);
    options.challenge = b64urlToBytes(options.challenge);
    options.user.id = b64urlToBytes(options.user.id);
    say("Waiting for your authenticator…");
    const credential = await navigator.credentials.create({ publicKey: options });
    const payload = {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToB64url(credential.response.clientDataJSON),
        attestationObject: bytesToB64url(credential.response.attestationObject),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
    const verified = await (await fetch("/register/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: payload, challenge: bytesToB64url(options.challenge) }),
    })).json();
    say(verified.ok ? "Registered. You can close this tab and run skill-sync login." : (verified.error ?? "Failed."));
  } catch (error) { say(String(error)); }
};`,
);

/**
 * Approves one machine's sign-in request with the passkey. It may be opened on any computer or phone: the token
 * goes to the daemon that opened the request, never to this page. `machine` is null once the request expired
 * or was claimed.
 */
export const approvePage = (input: { readonly requestId: string; readonly machine: string | null }): Response => input.machine === null
  ? shell("Sign-in expired", `<h1>This sign-in has expired</h1><p>Run <code>skill-sync login</code> again on the computer you are signing in.</p>`, "")
  : shell(
    "Sign in a computer",
    `<h1>Sign in to skill sync</h1>
     <p>Signing in <strong>${escapeHtml(input.machine)}</strong>. Approve only if you just ran <code>skill-sync login</code> on it.</p>
     <button id="go">Approve with passkey</button><p id="status"></p>`,
    `${CODEC}
const REQUEST = ${JSON.stringify(input.requestId)};
document.getElementById("go").onclick = async () => {
  try {
    await signIn(REQUEST);
    say("Approved. The computer signs in within a few seconds. Opening the dashboard…");
    setTimeout(() => { location.href = "/"; }, 1500);
  } catch (error) { say(String(error.message ?? error)); }
};`,
  );

const escapeHtml = (text: string): string => text.replace(/[<>&"]/g, (character) => `&#${character.charCodeAt(0)};`);

/** The dashboard's front door when there is no session. */
export const signInPage = (): Response => shell(
  "Skill sync",
  `<h1>Skill sync</h1>
   <p>Sign in with your jive.sh passkey to see your machines and folders.</p>
   <button id="go">Use passkey</button><p id="status"></p>`,
  `${CODEC}
document.getElementById("go").onclick = async () => {
  try {
    await signIn(undefined);
    location.reload();
  } catch (error) { say(String(error.message ?? error)); }
};`,
);

/**
 * The dashboard, in three tabs kept in the address's hash so a reload stays on one:
 * - Accounts: a table of every Claude, Codex and Grok account on the running computers (`renderAccounts`).
 * - Skills & computers: the skills every enabled folder shares, and a tree of computers → skills folders (Claude's,
 *   Codex's and Grok's), each folder one line with its checkbox and counts, opening to its skills and their files.
 * - Skill refinement: each computer's skill refinement workflow, drawn by `@jive-sh/workflow-platform`'s dashboard
 *   (`client/refinement-tab.tsx`, bundled to `/refinement.js` and loaded when the tab first opens).
 *
 * Fed by one WebSocket that receives a full snapshot on every change, so the page never has to reconcile
 * partial updates; each computer's refinement report comes on it separately, as it changes. Built with DOM calls rather than HTML strings: machine names, paths and skill names
 * come from outside, and none of it should be able to inject markup here.
 */
export const dashboardPage = (version: string): Response => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><title>Skill sync</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#666;--line:#e3e3e3;--card:#fafafa;--ok:#1a7f37;--warn:#b35900}
 @media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--muted:#999;--line:#2a2a2a;--card:#181818;--ok:#3fb950;--warn:#f0883e}}
 body{font:15px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
 main{max-width:66rem;margin:0 auto;padding:2rem 1.5rem}
 header{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
 h1{font-size:1.4rem;margin:0} h2{font-size:1.05rem;margin:1.8rem 0 .6rem}
 .muted{color:var(--muted)} .small{font-size:.85rem}
 #live.on{color:var(--ok)}
 header form{margin-left:auto}
 button{font:inherit;font-size:.85rem;padding:.3rem .8rem;border-radius:.4rem;border:1px solid var(--line);background:none;color:inherit;cursor:pointer}
 .card{border:1px solid var(--line);border-radius:.6rem;background:var(--card);padding:.8rem 1.1rem;margin-bottom:.8rem}
 details>summary{cursor:pointer;list-style-position:outside}
 .row{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
 .mono{font-family:ui-monospace,monospace;font-size:.88rem;word-break:break-all}
 ul.files{margin:.2rem 0 .4rem 1.4rem;padding:0;list-style:none} ul.files li{font-family:ui-monospace,monospace;font-size:.82rem;color:var(--muted)}
 .hash{margin-left:.6rem;font-family:ui-monospace,monospace;font-size:.78rem;padding:0 .3rem;border-radius:.25rem;border:1px solid var(--line)}
 .hash.same{color:var(--ok)} .hash.differs{color:var(--warn);border-color:currentColor}
 .rename{font-size:.75rem;padding:.05rem .5rem;margin-left:.2rem}
 .head input{font:inherit;font-size:1rem;padding:.1rem .3rem;border-radius:.3rem;border:1px solid var(--line);background:var(--bg);color:inherit}
 .dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--muted);display:inline-block;align-self:center}
 .machine.online .head .dot{background:var(--ok)}
 .machine>.head{font-weight:600;font-size:1.05rem}
 .folder{border-top:1px solid var(--line);padding:.6rem 0 .3rem}
 .skills{margin:.4rem 0 0 1.6rem}
 .skills>details{margin:.3rem 0} .skills>details>.skill{margin-left:1.2rem}
 .skill{padding:.15rem 0}
 .badge{font-size:.75rem;padding:.05rem .45rem;border-radius:1rem;border:1px solid var(--line);color:var(--muted)}
 .badge.synced{color:var(--ok);border-color:currentColor} .badge.local{color:var(--fg)}
 .state{font-size:.85rem} .ok{color:var(--ok)} .warn{color:var(--warn)}
 @keyframes spin{to{transform:rotate(360deg)}}
 .empty{color:var(--muted);font-size:.9rem;margin:.3rem 0}
 table.usage{border-collapse:collapse;width:100%;font-size:.88rem;background:var(--card);border:1px solid var(--line);border-radius:.6rem}
 table.usage th{text-align:left;font-weight:600;color:var(--muted);font-size:.8rem;white-space:nowrap}
 table.usage th,table.usage td{padding:.4rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}
 table.usage tr:last-child td{border-bottom:none}
 table.usage tr.machine-use td{border-bottom:none;padding-top:.1rem;padding-bottom:.1rem;font-size:.84rem}
 table.usage tr.provider td{font-weight:600;padding-top:.7rem;border-bottom:none}
 table.usage tr.account td{border-bottom:none}
 table.usage tr.account td:first-child{padding-left:1.6rem}
 table.usage tr.machine-use td:first-child{padding-left:3rem}
 table.usage tbody{border-bottom:1px solid var(--line)} table.usage tbody:last-child{border-bottom:none}
 .machine-use.online .dot{background:var(--ok)}
 nav.tabs{display:flex;gap:.2rem;border-bottom:1px solid var(--line);margin-bottom:1.2rem}
 nav.tabs button{border:none;border-bottom:3px solid transparent;border-radius:0;font-size:.95rem;padding:.45rem .9rem;color:var(--muted)}
 nav.tabs button[aria-selected="true"]{border-bottom-color:currentColor;color:var(--fg);font-weight:600}
 .folder>details>summary{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
 #accounts{overflow-x:auto} .nowrap{white-space:nowrap}
</style></head><body><main>
<header><h1>Skill sync</h1><span id="live" class="small muted">connecting…</span><span id="published" class="small muted"></span>
<form method="post" action="/logout"><button>Sign out</button></form></header>
<nav class="tabs" role="tablist">
 <button role="tab" data-tab="accounts">Accounts</button><button role="tab" data-tab="computers">Skills &amp; computers</button><button role="tab" data-tab="refinement">Skill refinement</button>
</nav>
<section id="tab-accounts" role="tabpanel"><div id="accounts"></div></section>
<section id="tab-computers" role="tabpanel" hidden><h2>Synced skills</h2><div id="skills"></div><h2>Computers</h2><div id="machines"></div></section>
<section id="tab-refinement" role="tabpanel" hidden><div id="refinement"><p class="empty">Loading…</p></div></section>
</main><script type="module">
/** The version that built this page. A snapshot from another version means a deploy happened: reload. */
const VERSION = ${JSON.stringify(version)};
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value; else if (key.startsWith("on")) node[key] = value; else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};
const ago = (at) => {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
};
/** Which <details> are open, by key, so a re-render on every snapshot does not collapse them. */
/** Each <details> the user has toggled, by key; ones never toggled use their default. */
const toggled = new Map();
const details = (key, summary, ...body) => section(key, false, summary, ...body);
const section = (key, openByDefault, summary, ...body) => {
  const node = el("details", {}, el("summary", {}, ...summary), ...body);
  node.open = toggled.get(key) ?? openByDefault;
  node.ontoggle = () => { toggled.set(key, node.open); };
  return node;
};
/**
 * Files with the first 8 characters of their SHA-256. Given the synced copy's hashes, a folder's file is
 * marked green when it is the synced version and amber when it differs, with the full hash on hover.
 */
const fileList = (files, synced) => el("ul", { class: "files" }, ...files.map((file) => {
  const reference = synced?.get(file.path);
  const tone = !reference || !file.hash ? "" : reference === file.hash ? " same" : " differs";
  return el("li", {}, file.path,
    file.hash ? el("span", { class: "hash" + tone, title: file.hash + (tone === " differs" ? " (synced: " + reference + ")" : "") },
      file.hash.slice(0, 8)) : null,
    tone === " differs" ? el("span", { class: "warn small" }, " differs from synced") : null);
}));
const nameOf = (machine) => snapshot.names[machine] ?? machine;
/**
 * A synced folder written from its machine's home. Every folder is "<home>/.<agent home>/skills" by
 * construction (".claude…" or ".agents"), so the home is whatever precedes those two segments: no
 * guessing at /Users or /home.
 */
const tilde = (path) => {
  const match = /[\\\\/](\\.[^\\\\/]+)[\\\\/]skills$/.exec(path);
  return match ? "~/" + match[1] + "/skills" : path;
};
/** The machine being renamed, and what has been typed so far — kept across re-renders from new snapshots. */
let editing = null, draft = "";
let socket, snapshot, retry = 1000;

function folderState(machine, folder) {
  if (!folder.enabled) return ["not syncing", ""];
  if (!machine.online) return ["daemon offline", ""];
  if (folder.state === "attention") return ["needs attention: " + (folder.detail ?? ""), "warn"];
  return ["in sync", "ok"];
}

function skillBadge(skill) {
  if (skill.synced && skill.local) return ["synced", "synced"];
  if (skill.synced) return ["synced · arriving", "synced"];
  if (skill.local) return ["local to this folder", "local"];
  return ["shared, not taken", ""];
}

function renderSkills() {
  const shared = new Map(snapshot.skills.map((skill) => [skill.name, skill]));
  document.getElementById("skills").replaceChildren(snapshot.skills.length === 0
    ? el("p", { class: "empty" }, "No skills are synced yet. Check one in a folder below.")
    : el("div", { class: "card" }, ...snapshot.skills.map((skill) => {
        // A skill ticked a moment ago has no files on the server until its folder pushes them.
        const latest = skill.files.reduce((a, b) => (a === undefined || b.editedAt > a.editedAt ? b : a), undefined);
        return details("skill:" + skill.name,
          [el("strong", {}, skill.name), " ", el("span", { class: "muted small" },
            latest === undefined ? "arriving" : skill.files.length + " file" + (skill.files.length === 1 ? "" : "s") + " · last edited on " + nameOf(latest.updatedBy) + " " + ago(latest.editedAt))],
          fileList(skill.files));
      })));
  return shared;
}

function renderMachines(shared) {
  const root = document.getElementById("machines");
  root.replaceChildren(...(snapshot.machines.length === 0 ? [el("p", { class: "empty" }, "No computers yet. Run skill-sync login on one.")] : []),
    ...snapshot.machines.map((machine) => el("section", { class: "card machine" + (machine.online ? " online" : "") },
      el("div", { class: "row head" }, el("span", { class: "dot" }), ...machineName(machine),
        el("span", { class: "muted small", style: "font-weight:normal" },
          machine.online ? "daemon running" : "offline · last seen " + ago(machine.lastSeen)),
        machine.online ? daemonVersion(machine.daemonVersion) : null),
      ...(machine.folders.length === 0 ? [el("p", { class: "empty" }, "No skills folders reported yet.")] : []),
      ...machine.folders.map((folder) => {
        const [text, tone] = folderState(machine, folder);
        const box = el("input", { type: "checkbox", "aria-label": "Sync " + folder.path });
        box.checked = folder.enabled;
        box.onchange = () => socket?.send(JSON.stringify({ type: "setFolder", machine: machine.machine, path: folder.path, enabled: box.checked }));
        const synced = folder.skills.filter((skill) => skill.synced);
        const local = folder.skills.filter((skill) => !skill.synced);
        const differ = synced.filter((skill) => skill.local && differsFromShared(skill, shared)).length;
        // One line per folder: its checkbox, where it is, its state and its counts; its skills and files open below it.
        return el("div", { class: "folder" }, details(machine.machine + "|" + folder.path,
          [box, el("span", { class: "mono", title: folder.path }, tilde(folder.path)), el("span", { class: "state " + tone }, text),
            el("span", { class: "muted small" }, synced.length + " synced · " + local.length + " not synced"),
            differ > 0 ? el("span", { class: "warn small" }, "△ " + differ + " differ" + (differ === 1 ? "s" : "")) : null,
            folder.lastActivity ? el("span", { class: "muted small", title: folder.lastActivity }, "last change " + stamp(folder.lastActivityAt)) : null],
          folder.enabled ? el("div", { class: "skills" },
            // Synced open, not synced closed: the second is usually the long list. Ticking a skill moves
            // it across once the hub confirms, because both lists are rebuilt from every snapshot.
            section(machine.machine + "|" + folder.path + "|synced", true,
              [el("strong", {}, "Synced"), " ", el("span", { class: "muted small" }, "(" + synced.length + ")")],
              ...synced.map(skillRow)),
            section(machine.machine + "|" + folder.path + "|local", false,
              [el("strong", {}, "Not synced"), " ", el("span", { class: "muted small" }, "(" + local.length + ")")],
              ...local.map(skillRow))) : el("p", { class: "empty" }, "Tick the folder to sync its skills.")));

        function skillRow(skill) {
          const [label, kind] = skillBadge(skill);
          const skillBox = el("input", { type: "checkbox", "aria-label": "Sync " + skill.name + " on every machine" });
          skillBox.checked = skill.synced;
          skillBox.onchange = () => socket?.send(JSON.stringify({ type: "setSkill", skill: skill.name, synced: skillBox.checked }));
          const sharedFiles = shared.get(skill.name)?.files ?? [];
          const files = skill.local ? skill.files : sharedFiles;
          const reference = skill.local ? new Map(sharedFiles.map((file) => [file.path, file.hash])) : undefined;
          return el("div", { class: "skill" }, details(machine.machine + "|" + folder.path + "|" + skill.name,
            [skillBox, " ", el("span", { class: "mono" }, skill.name), " ", el("span", { class: "badge " + kind }, label)],
            fileList(files, reference)));
        }
      }))));
}

/** True when a folder's copy of a synced skill has a file whose hash is not the synced one. */
const differsFromShared = (skill, shared) => {
  const reference = new Map((shared.get(skill.name)?.files ?? []).map((file) => [file.path, file.hash]));
  return skill.files.some((file) => file.hash && reference.has(file.path) && reference.get(file.path) !== file.hash);
};

/** How long until a time, to the two largest units: "2 d 4 h", "3 h 12 min", "5 min". */
const until = (at) => {
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60000));
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
  return d > 0 ? d + " d " + h + " h" : h > 0 ? h + " h " + m + " min" : m + " min";
};
const moneyText = (money) => (money.amountMinor / 10 ** money.exponent)
  .toLocaleString(undefined, { style: "currency", currency: money.currency });
const tokenText = (count) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(count);
const TOOL_NAMES = { claude: "Claude", codex: "Codex", grok: "Grok" };
/** Where each tool's figure for this machine's use comes from, for the hover on it. */
const LOCAL_SOURCES = {
  claude: "Claude Code's own estimate at list price, saved in each session's file when the session ends, is cleared,"
    + " resumed or forked; summed over sessions active in the period. Your provider's bill can differ.",
  codex: "Tokens Codex counted in sessions active in the period, cached input included.",
  grok: "The cost Grok reports for each session (grok usage), summed over sessions active in the period.",
};
/** Limits ordered as their windows are long; a limit on one model follows the limit it narrows. */
const LIMIT_ORDER = ["5-hour", "daily", "weekly", "monthly"];
const limitRank = (name) => {
  const base = LIMIT_ORDER.findIndex((known) => name === known || name.startsWith(known + " "));
  return (base === -1 ? LIMIT_ORDER.length : base) * 2 + (LIMIT_ORDER.includes(name) ? 0 : 1);
};

/** A time as the clock shows it, with the date when it is not today, then how long ago: "10:04 PM · 3 min ago". */
const stamp = (at) => {
  const date = new Date(at);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = date.toDateString() === new Date().toDateString() ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", ";
  return day + clock + " · " + ago(at);
};
const onlineMachines = () => new Set(snapshot.machines.filter((machine) => machine.online).map((machine) => machine.machine));
/** An account by its email or the id its tool gives; one its tool cannot name is its folder, marked unidentified. */
const accountName = (account) => account.key.kind === "email" ? [account.key.email]
  : account.key.kind === "id" ? [account.key.id]
  : ["~/" + account.key.home, el("span", { class: "muted small" }, " unidentified")];

/**
 * One row per account (grouped by the hub), with its limits from the freshest reading any
 * computer sent and its local use added up; under it, a row per computer that has it, with whether that
 * computer is connected, when it last sent the account, and its own local use. Offline computers keep the
 * values they last sent.
 */
function renderAccounts() {
  const accounts = snapshot.accounts;
  const root = document.getElementById("accounts");
  if (accounts.length === 0) {
    root.replaceChildren(el("p", { class: "empty" }, "No computer has reported an account."));
    return;
  }
  const online = onlineMachines();
  const limits = [...new Set(accounts.flatMap((account) => account.limits.state === "reading" ? account.limits.windows.map((window) => window.name) : []))]
    .sort((a, b) => limitRank(a) - limitRank(b) || a.localeCompare(b));
  const credits = accounts.some((account) => account.limits.state === "reading" && account.limits.spent);
  const span = limits.length + (credits ? 1 : 0);
  const period = accounts.map((account) => account.localTotal.periodDays).find((days) => days !== undefined) ?? 30;
  const head = el("tr", {}, el("th", {}, "Account"),
    ...limits.map((name) => el("th", { title: "Share of the account's " + name + " limit used, across every computer, and time until it resets" }, name[0].toUpperCase() + name.slice(1))),
    credits ? el("th", {}, "Extra usage") : null,
    el("th", { title: "An account's total over every computer, then each computer's own share" }, "Use, " + period + " d"),
    el("th", { title: "An account's limits were read then; a computer last sent the account then" }, "As of"));
  const columns = 1 + span + 2;
  // Provider, then account, then the computers the account runs on: each provider is named once.
  const providerOf = (account) => {
    const tool = TOOL_NAMES[account.tool] ?? account.tool;
    const bedrock = account.localTotal.state === "spend" && account.localTotal.provider === "bedrock" && account.limits.state !== "reading";
    return bedrock ? tool + " on Bedrock" : tool;
  };
  const providers = [...new Set(accounts.map(providerOf))];
  root.replaceChildren(el("table", { class: "usage" }, el("thead", {}, head), ...providers.map((provider) => el("tbody", {},
    el("tr", { class: "provider" }, el("td", { colspan: String(columns) }, provider)),
    ...accounts.filter((account) => providerOf(account) === provider).flatMap((account) => {
      const accountRow = el("tr", { class: "account" },
        el("td", { class: "nowrap", title: account.identity?.plan ? "plan: " + account.identity.plan : "" }, ...accountName(account)),
        ...limitCells(account.limits, span, limits, credits),
        el("td", { class: "nowrap", title: localHover(account.tool, account.localTotal) }, localText(account.localTotal)),
        el("td", { class: "muted nowrap", title: limitsSource(account) }, account.limits.state === "reading" ? stamp(account.limits.asOf) : ""));
      const machineRows = account.machines.map((reading) => el("tr", {
        class: "machine-use" + (online.has(reading.machine) ? " online" : ""),
      },
        el("td", { class: "nowrap", title: "~/" + reading.usage.home + (online.has(reading.machine) ? " · connected" : " · offline") },
          el("span", { class: "dot" }), " ", nameOf(reading.machine)),
        span > 0 ? el("td", { colspan: String(span) }) : null,
        el("td", { class: "nowrap", title: localHover(account.tool, reading.usage.local) }, localText(reading.usage.local)),
        el("td", { class: "muted nowrap" }, stamp(reading.reportedAt))));
      return [accountRow, ...machineRows];
    })))));
}

/** One cell per limit column; a row with no reading spans them all with why. */
function limitCells(reading, span, names, credits) {
  if (reading.state === "none") return [el("td", { colspan: String(span), class: "muted" }, reading.reason)];
  if (reading.state === "unknown") return [el("td", { colspan: String(span), class: "warn", title: reading.reason }, "unknown: " + reading.reason)];
  const cells = names.map((name) => {
    const window = reading.windows.find((candidate) => candidate.name === name);
    if (window === undefined) return el("td", { class: "muted" }, "");
    // Started over since the reading: how much of the new window is used is not known yet.
    if (window.resetsAt !== null && window.resetsAt <= Date.now()) return el("td", { class: "muted" }, "reset since");
    const used = Math.round(window.usedPercent);
    return el("td", { class: used >= 90 ? "warn" : "", title: window.resetsAt === null ? "" : "resets " + new Date(window.resetsAt).toLocaleString() },
      el("strong", {}, used + "%"), window.resetsAt === null ? "" : el("div", { class: "muted small nowrap" }, "resets in " + until(window.resetsAt)));
  });
  if (credits) {
    cells.push(el("td", {}, reading.spent ? moneyText(reading.spent.used) + (reading.spent.limit ? " of " + moneyText(reading.spent.limit) : "") : ""));
  }
  return cells;
}

function localText(local) {
  if (local.state === "none") return el("span", { class: "muted" }, "none");
  if (local.state === "unknown") return el("span", { class: "warn" }, "unknown");
  const atLeast = local.partial ? "at least " : "";
  if (local.state === "tokens") return local.count === 0 && !local.partial ? el("span", { class: "muted" }, "none") : atLeast + tokenText(local.count) + " tokens";
  return atLeast + moneyText(local.spent);
}

function localHover(tool, local) {
  if (local.state === "unknown") return local.reason;
  const sessions = local.state === "spend" || local.state === "tokens" ? local.sessions + (local.sessions === 1 ? " session. " : " sessions. ") : "";
  return sessions + (LOCAL_SOURCES[tool] ?? "");
}

/** Where an account's limits came from, for the hover on their time. */
function limitsSource(account) {
  if (account.limits.state !== "reading") return "";
  const at = new Date(account.limits.asOf).toLocaleString();
  if (account.limits.source === "account") return "Read from " + TOOL_NAMES[account.tool] + "'s CLI at " + at;
  return "The CLI could not be asked (" + (account.limits.cliFailure ?? "no reason given") + "), so this is what "
    + TOOL_NAMES[account.tool] + " last recorded, at " + at;
}


/** Numeric X.Y.Z parts, or null for anything else; a prerelease suffix is ignored. */
const versionParts = (version) => {
  const match = /^(\\d+)\\.(\\d+)\\.(\\d+)/.exec(version ?? "");
  return match ? match.slice(1).map(Number) : null;
};
/** True only when both versions parse and the first is older. */
const isOlder = (version, than) => {
  const [a, b] = [versionParts(version), versionParts(than)];
  if (a === null || b === null) return false;
  const index = a.findIndex((part, i) => part !== b[i]);
  return index !== -1 && a[index] < b[index];
};
/**
 * The version a running daemon reported. One behind the published version is marked: it upgrades itself
 * within minutes. Daemons before 0.4.6 report none.
 */
function daemonVersion(version) {
  if (version === null) return el("span", { class: "muted small", style: "font-weight:normal" }, "version unknown");
  const behind = isOlder(version, snapshot.publishedVersion);
  return el("span", { class: "small mono" + (behind ? " warn" : ""), style: "font-weight:normal" },
    version + (behind ? " (update pending)" : ""));
}

/** The machine's display name with a Rename button, or the input while it is being renamed. */
function machineName(machine) {
  if (editing !== machine.machine) {
    return [machine.name,
      el("button", { class: "rename", onclick: () => { editing = machine.machine; draft = machine.name; render(); } }, "Rename")];
  }
  const input = el("input", { value: draft, "aria-label": "New name for " + machine.machine });
  const save = () => {
    socket?.send(JSON.stringify({ type: "renameMachine", machine: machine.machine, name: input.value }));
    editing = null; render();
  };
  input.oninput = () => { draft = input.value; };
  input.onkeydown = (event) => {
    if (event.key === "Enter") save();
    if (event.key === "Escape") { editing = null; render(); }
  };
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  return [input, el("button", { class: "rename", onclick: save }, "Save"),
    el("button", { class: "rename", onclick: () => { editing = null; render(); } }, "Cancel")];
}

function render() {
  if (!snapshot) return;
  document.getElementById("published").textContent =
    "published: " + (snapshot.publishedVersion ?? "unknown (npm unreachable)");
  const shared = renderSkills();
  renderAccounts();
  renderMachines(shared);
}

/** Each computer's last skill refinement report, by machine, and the Skill refinement tab's listeners. */
const refinements = new Map();
const refinementListeners = new Set();
const refinementChanged = () => { for (const listener of refinementListeners) listener(); };
/** What the Skill refinement tab (/refinement.js) reads; it holds no connection of its own. */
window.skillSyncRefinement = {
  current: () => ({ refinements: [...refinements.values()].sort((a, b) => nameOf(a.machine).localeCompare(nameOf(b.machine))), machines: snapshot?.machines ?? [] }),
  subscribe: (listener) => { refinementListeners.add(listener); return () => refinementListeners.delete(listener); },
  setLimit: async (machine, change) => {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("this page is not connected; it reconnects by itself");
    if (!onlineMachines().has(machine)) throw new Error(nameOf(machine) + " is offline");
    socket.send(JSON.stringify({ type: "setLimit", machine, workflow: change.workflow, limit: change.limit, value: change.value }));
  },
};

const TABS = ["accounts", "computers", "refinement"];
let refinementLoaded = false;
/** Shows the tab the address names, the first one when it names none; the Skill refinement tab's code loads the first time. */
function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const name of TABS) {
    document.getElementById("tab-" + name).hidden = name !== tab;
    document.querySelector("[data-tab='" + name + "']").setAttribute("aria-selected", String(name === tab));
  }
  if (tab === "refinement" && !refinementLoaded) {
    refinementLoaded = true;
    document.head.append(el("link", { rel: "stylesheet", href: "/refinement.css?v=" + encodeURIComponent(VERSION) }));
    import("/refinement.js?v=" + encodeURIComponent(VERSION)).catch((error) => {
      document.getElementById("refinement").replaceChildren(el("p", { class: "warn" }, "The Skill refinement tab could not load: " + (error?.message ?? error)));
    });
  }
}
for (const button of document.querySelectorAll("nav.tabs button")) button.onclick = () => { location.hash = button.dataset.tab; };
window.addEventListener("hashchange", showTab);
showTab();

function connect() {
  socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/dashboard/live");
  socket.onopen = () => { retry = 1000; const live = document.getElementById("live"); live.textContent = "● live"; live.classList.add("on"); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "refinement") { refinements.set(message.machine, message); refinementChanged(); return; }
    if (message.type !== "snapshot") return;
    if (message.version !== VERSION && reloadAllowed()) { location.reload(); return; }
    snapshot = message; render(); refinementChanged();
  };
  socket.onclose = () => {
    const live = document.getElementById("live"); live.textContent = "reconnecting…"; live.classList.remove("on");
    setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);
  };
}
/**
 * At most three reloads a minute: the page and the hub are updated by one deploy, but if they ever
 * disagree for longer, a page that reloads on every snapshot would never let you read it.
 */
function reloadAllowed() {
  const recent = JSON.parse(sessionStorage.getItem("reloads") ?? "[]").filter((at) => Date.now() - at < 60000);
  if (recent.length >= 3) return false;
  sessionStorage.setItem("reloads", JSON.stringify([...recent, Date.now()]));
  return true;
}

connect();
setInterval(render, 30000);
</script></body></html>`,
  { headers: HTML_HEADERS },
);
