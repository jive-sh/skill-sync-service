import type { AccountIdentity, AccountKey, AccountLimits, AccountUsage, AccountView, LocalUse, MachineAccountReading, Money, UsageWindow } from "@jive-sh/skill-sync";

/**
 * Checks the account usage a daemon sends before the hub keeps it.
 *
 * The daemon is authenticated, but what it sends is kept on its connection, which holds at most 16 KiB,
 * and is shown to every dashboard. So every field is checked for type, every string and list is bounded,
 * and an entry that fails is dropped: one bad entry must not hide the machine's other accounts. Entries in
 * the shape daemons before 0.5.0 sent fail too; those daemons upgrade themselves within minutes.
 */

const MAX_ACCOUNTS = 32;
const MAX_WINDOWS = 6;

export function accountsFrom(raw: unknown): AccountUsage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ACCOUNTS).flatMap((entry): AccountUsage[] => {
    const account = accountFrom(entry);
    return account === undefined ? [] : [account];
  });
}

function accountFrom(raw: unknown): AccountUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const { tool, home } = raw;
  if ((tool !== "claude" && tool !== "codex" && tool !== "grok") || typeof home !== "string") return undefined;
  const identity = raw.identity === null ? null : identityFrom(raw.identity);
  const limits = limitsFrom(raw.limits);
  const local = localFrom(raw.local);
  if (identity === undefined || limits === undefined || local === undefined) return undefined;
  return { tool, home: home.slice(0, 80), identity, limits, local };
}

function identityFrom(raw: unknown): AccountIdentity | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, email, plan } = raw;
  if (typeof id !== "string" || typeof email !== "string" || !(plan === null || typeof plan === "string")) return undefined;
  return { id: id.slice(0, 120), email: email.slice(0, 120), plan: plan === null ? null : plan.slice(0, 40) };
}

function limitsFrom(raw: unknown): AccountLimits | undefined {
  if (!isRecord(raw)) return undefined;
  const { state } = raw;
  if (state === "none" || state === "unknown") return { state, reason: text(raw.reason, 200) };
  if (state !== "reading" || !isFinite(raw.asOf) || (raw.source !== "account" && raw.source !== "saved") || !Array.isArray(raw.windows)) {
    return undefined;
  }
  const windows = raw.windows.slice(0, MAX_WINDOWS).map(windowFrom);
  if (windows.some((window) => window === undefined)) return undefined;
  const spent = spentFrom(raw.spent);
  if (spent === null) return undefined;
  return {
    state, asOf: raw.asOf, source: raw.source, windows: windows as UsageWindow[],
    ...(typeof raw.cliFailure === "string" ? { cliFailure: raw.cliFailure.slice(0, 200) } : {}),
    ...(spent === undefined ? {} : { spent }),
  };
}

function localFrom(raw: unknown): LocalUse | undefined {
  if (!isRecord(raw)) return undefined;
  const { state } = raw;
  if (state === "none") return { state };
  if (state === "unknown") return { state, reason: text(raw.reason, 200) };
  if (state === "tokens") {
    const { periodDays, count, sessions } = raw;
    if (!isFinite(periodDays) || !isFinite(count) || !Number.isInteger(sessions)) return undefined;
    return { state, periodDays, count, sessions: sessions as number };
  }
  if (state !== "spend") return undefined;
  const { asOf, periodDays, sessions, partial, provider } = raw;
  const spent = moneyFrom(raw.spent);
  if (!isFinite(asOf) || !isFinite(periodDays) || !Number.isInteger(sessions) || typeof partial !== "boolean"
    || (provider !== "bedrock" && provider !== null) || spent === undefined) {
    return undefined;
  }
  return { state, asOf, periodDays, spent, sessions: sessions as number, partial, provider };
}

function windowFrom(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, minutes, usedPercent, resetsAt } = raw;
  if (typeof name !== "string" || !isFinite(usedPercent) || !(minutes === null || isFinite(minutes)) || !(resetsAt === null || isFinite(resetsAt))) {
    return undefined;
  }
  return { name: name.slice(0, 40), minutes, usedPercent, resetsAt };
}

type Spent = NonNullable<Extract<AccountLimits, { state: "reading" }>["spent"]>;

/** Undefined when absent, null when present and malformed. */
function spentFrom(raw: unknown): Spent | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const used = moneyFrom(raw.used);
  const limit = raw.limit === null ? null : moneyFrom(raw.limit);
  if (used === undefined || limit === undefined) return null;
  return { used, limit };
}

function moneyFrom(raw: unknown): Money | undefined {
  if (!isRecord(raw)) return undefined;
  const { amountMinor, currency, exponent } = raw;
  if (!isFinite(amountMinor) || typeof currency !== "string" || !Number.isInteger(exponent) || (exponent as number) < 0 || (exponent as number) > 6) {
    return undefined;
  }
  return { amountMinor, currency: currency.slice(0, 8), exponent: exponent as number };
}

const text = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Every account across every machine, one entry each: an account its tool names is one entry however many
 * machines use it, keyed by its email (else the id its tool gives); one its tool cannot name is one entry
 * per folder per machine. Its limits are the freshest reading any machine sent, and its local use is each
 * machine's added up.
 */
export function groupAccounts(readings: ReadonlyArray<MachineAccountReading>): AccountView[] {
  const groups = new Map<string, { key: AccountKey; readings: MachineAccountReading[] }>();
  for (const reading of readings) {
    const key = accountKey(reading);
    const id = JSON.stringify([reading.usage.tool, key]);
    const group = groups.get(id) ?? { key, readings: [] };
    group.readings.push(reading);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ key, readings: group }): AccountView => {
    const sorted = [...group].sort((a, b) => a.machine.localeCompare(b.machine));
    const freshest = group.reduce(fresher);
    return {
      tool: freshest.usage.tool,
      key,
      identity: group.find((reading) => reading.usage.identity !== null)?.usage.identity ?? null,
      limits: freshest.usage.limits,
      localTotal: addLocalUse(group.map((reading) => reading.usage.local)),
      machines: sorted,
    };
  }).sort((a, b) => a.tool.localeCompare(b.tool) || keyText(a.key).localeCompare(keyText(b.key)));
}

function accountKey({ machine, usage }: MachineAccountReading): AccountKey {
  if (usage.identity !== null && usage.identity.email !== "") return { kind: "email", email: usage.identity.email };
  if (usage.identity !== null && usage.identity.id !== "") return { kind: "id", id: usage.identity.id };
  return { kind: "unidentified", machine, home: usage.home };
}

const keyText = (key: AccountKey): string =>
  key.kind === "email" ? key.email : key.kind === "id" ? key.id : `${key.home} ${key.machine}`;

/** Whose limits to show: a reading beats none, the later reading wins, and without readings the latest report. */
function fresher(a: MachineAccountReading, b: MachineAccountReading): MachineAccountReading {
  const [x, y] = [a.usage.limits, b.usage.limits];
  if (x.state === "reading" && y.state === "reading") return y.asOf > x.asOf ? b : a;
  if (x.state === "reading") return a;
  if (y.state === "reading") return b;
  return b.reportedAt > a.reportedAt ? b : a;
}

/** Machines' local use added up. One that could not be read makes the total a lower bound. */
export function addLocalUse(uses: ReadonlyArray<LocalUse>): LocalUse {
  const read = uses.filter((use) => use.state === "spend" || use.state === "tokens");
  const unreadable = uses.find((use) => use.state === "unknown");
  if (read.length === 0) return unreadable ?? { state: "none" };
  const spends = read.filter((use) => use.state === "spend");
  const tokens = read.filter((use) => use.state === "tokens");
  if (spends.length === 0) {
    return {
      state: "tokens",
      periodDays: tokens[0]!.periodDays,
      count: tokens.reduce((sum, use) => sum + use.count, 0),
      sessions: tokens.reduce((sum, use) => sum + use.sessions, 0),
      ...(unreadable === undefined ? {} : { partial: true }),
    };
  }
  // One tool reports one kind and one currency; a mismatch is not added, so the total says "at least".
  const first = spends[0]!;
  const same = spends.filter((use) => use.spent.currency === first.spent.currency && use.spent.exponent === first.spent.exponent);
  return {
    state: "spend",
    asOf: Math.max(...same.map((use) => use.asOf)),
    periodDays: first.periodDays,
    spent: { ...first.spent, amountMinor: same.reduce((sum, use) => sum + use.spent.amountMinor, 0) },
    sessions: same.reduce((sum, use) => sum + use.sessions, 0),
    partial: same.some((use) => use.partial) || unreadable !== undefined || same.length !== spends.length || tokens.length > 0,
    provider: same.some((use) => use.provider === "bedrock") ? "bedrock" : null,
  };
}
