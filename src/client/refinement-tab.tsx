/**
 * The dashboard's Skill refinement tab: each computer's skill refinement workflow, drawn by `@jive-sh/workflow-platform`'s
 * own `WorkflowsDashboard`, one section per computer.
 *
 * The page (`pages.ts`) holds the one live connection to the hub and hands this tab what it receives through
 * `window.skillSyncRefinement`: each computer's last refinement report and the snapshot's computers. An opened workflow's
 * figures come from the report too, read through the service's figures route, which is where the dashboard asks for them.
 * This file is bundled for the browser with React at build time (`build:client`) and loaded only when the tab first opens,
 * so the rest of the page stays the plain script it was.
 *
 * Both dashboard imports are file paths that `src/client/tsconfig.json` names: the platform's release leaves its dashboard
 * out of its exports, and its README says hosts name the two files this way until its build exports them.
 */
import { WorkflowsDashboard, type WorkflowsPageData } from "@jive-sh/workflow-platform/dashboard";
import "@jive-sh/workflow-platform/dashboard/dashboard.css";
import type { LimitChange, MachineRefinement, MachineView } from "@jive-sh/skill-sync";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

/** What the page gives this tab. */
export interface RefinementSource {
  readonly current: () => { readonly refinements: ReadonlyArray<MachineRefinement>; readonly machines: ReadonlyArray<MachineView> };
  /** Calls `listener` after each report or snapshot; returns how to stop. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Sends a limit to a computer's daemon through the hub; fails when the page or the computer is not connected. */
  readonly setLimit: (machine: string, change: LimitChange) => Promise<void>;
}

declare global {
  interface Window {
    skillSyncRefinement?: RefinementSource;
  }
}

/** Where a step's definition is: the workflow's source in skill-sync's repository. */
const SOURCE_ROOT = "https://github.com/jive-sh/skill-sync/blob/main/src/internal/skill-refinement/";

/** A time as the clock shows it, with the date when it is not today, then how long ago: "10:04 PM · 3 min ago". */
const stamp = (at: number): string => {
  const date = new Date(at);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = date.toDateString() === new Date().toDateString() ? "" : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, `;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const ago = seconds < 60 ? "just now" : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} d ago`;
  return `${day}${clock} · ${ago}`;
};

function Computer({ report, machine, source }: { readonly report: MachineRefinement; readonly machine: MachineView | undefined; readonly source: RefinementSource }) {
  const online = machine?.online === true;
  const name = machine?.name ?? report.machine;
  const heading = (
    <div className="row head">
      <span className="dot" />
      <strong>{name}</strong>
      <span className="muted small">{online ? "online" : "offline, last reported"} · {stamp(report.reportedAt)}</span>
    </div>
  );
  if (report.refinement.state === "notRunning") {
    return <section className={`card machine${online ? " online" : ""}`}>{heading}<p className="empty">Not running: {report.refinement.reason}</p></section>;
  }
  // The daemon sends exactly what the platform's view and runs give (`startSkillRefinement`); the wire carries it as an object.
  const data = report.refinement.data as unknown as WorkflowsPageData;
  return (
    <section className={`card machine${online ? " online" : ""}`}>
      <WorkflowsDashboard
        data={data}
        error={null}
        figuresUrl={(workflow) => `/dashboard/refinement-figures?${new URLSearchParams({ machine: report.machine, workflow })}`}
        header={heading}
        sourceHref={(link) => `${SOURCE_ROOT}${link.path}#L${link.line}`}
        phaseLabel={() => "Skills"}
        setLimit={online ? (change) => source.setLimit(report.machine, change) : undefined}
      />
    </section>
  );
}

function RefinementTab({ source }: { readonly source: RefinementSource }) {
  const [state, setState] = useState(source.current);
  useEffect(() => {
    const stop = source.subscribe(() => setState(source.current()));
    // What arrived between the first render and this subscription, and every relative time, read again.
    setState(source.current());
    const tick = setInterval(() => setState(source.current()), 30_000);
    return () => { stop(); clearInterval(tick); };
  }, [source]);
  const byMachine = new Map(state.machines.map((machine) => [machine.machine, machine]));
  if (state.refinements.length === 0) {
    return <p className="empty">No computer has reported its skill refinement workflow yet.</p>;
  }
  return <>{state.refinements.map((report) => <Computer key={report.machine} report={report} machine={byMachine.get(report.machine)} source={source} />)}</>;
}

const source = window.skillSyncRefinement;
const root = document.getElementById("refinement");
if (source !== undefined && root !== null) createRoot(root).render(<RefinementTab source={source} />);
