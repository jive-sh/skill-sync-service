import type { FolderPrefs } from "@jive-sh/skill-sync";
import type { Env } from "./env";

/**
 * What a machine should sync: each of its enabled folders, each with every skill in `synced_skills`.
 * Deleted skills are included, so each daemon pulls the deletion and removes its own copy.
 *
 * One query used by both the worker (answering a registration) and the hub (pushing a dashboard change),
 * so the two can never disagree about what a checkbox means.
 */
export async function prefsFor(env: Env, machine: string): Promise<FolderPrefs[]> {
  const [folders, list] = await env.DB.batch([
    env.DB.prepare("SELECT path FROM folders WHERE machine = ? AND enabled = 1 ORDER BY path").bind(machine),
    env.DB.prepare("SELECT skill FROM synced_skills ORDER BY skill"),
  ]);
  const skills = ((list?.results ?? []) as { skill: string }[]).map((row) => row.skill);
  return ((folders?.results ?? []) as { path: string }[]).map((row) => ({ path: row.path, skills }));
}

/** SQL for a file's skill: its first path segment. Must agree with `skillOf` in @jive-sh/skill-sync. */
export const SKILL_OF_PATH = "CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE path END";
