/**
 * The rules of updating, kept away from electron-updater so they can be tested without one.
 *
 * Everything here is a decision — may we check now, what does the user see — rather than an action.
 * The action is three lines in the main process; the decisions are what get them wrong.
 */

/** How the update machinery reports itself, in the order a check goes through. */
export type UpdatePhase =
  | "idle"            // nothing has happened yet this run
  | "checking"
  | "current"         // checked, and this is the newest there is
  | "available"       // a newer one exists; downloading it is the next step
  | "downloading"
  | "ready"           // downloaded and waiting for a restart
  | "failed"
  | "unsupported";    // a build that cannot update itself: dev, portable, a Linux package

export interface UpdateState {
  phase: UpdatePhase;
  /** The version this build is. */
  current: string;
  /** The version found, when one was. */
  latest: string | null;
  /** 0-100 while downloading. */
  percent: number;
  /** Why the last check failed, in words a person can act on. */
  error: string | null;
  /** When the last completed check finished, epoch ms. */
  checkedAt: number | null;
}

export interface UpdateConfig {
  /** Look for updates on a timer, and download what it finds. */
  automatic: boolean;
}

export const UPDATE_DEFAULTS: UpdateConfig = { automatic: true };

/** Wait before the first check, so a launch is not held up by the network. */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** And between checks after that. Six hours: releases are not that frequent. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * The shortest gap between two checks of any kind.
 *
 * A person leaning on "Check now" should not send a request per click, but should never be told to
 * wait either — inside this window the answer already known is repeated instead.
 */
export const MIN_CHECK_GAP_MS = 60_000;

/** The message keys this module names; the dictionaries define what they say. */
export type UpdateMessageKey =
  | "update.check" | "update.checking" | "update.download" | "update.downloading" | "update.restart"
  | "update.state.unsupported" | "update.state.checking" | "update.state.downloading"
  | "update.state.ready" | "update.state.available" | "update.state.current" | "update.state.idle"
  | "update.state.failed" | "update.state.failedWith";

export function initialState(current: string, supported: boolean): UpdateState {
  return {
    phase: supported ? "idle" : "unsupported",
    current,
    latest: null,
    percent: 0,
    error: null,
    checkedAt: null,
  };
}

/**
 * Whether a check should actually go out.
 *
 * `manual` is a click, which beats the timer's own gap but not a check already in flight — two
 * overlapping checks report two different phases into the same state and one of them wins at random.
 */
export function shouldCheck(
  state: UpdateState,
  { manual, now, config }: { manual: boolean; now: number; config: UpdateConfig },
): boolean {
  if (state.phase === "unsupported") return false;
  if (state.phase === "checking" || state.phase === "downloading") return false;
  // Already downloaded: the next step is a restart, not another check.
  if (state.phase === "ready") return false;
  if (!manual && !config.automatic) return false;
  if (state.checkedAt !== null && now - state.checkedAt < MIN_CHECK_GAP_MS) return false;
  return true;
}

/** Which message the button shows, given where the update stands. */
export function actionLabel(state: UpdateState): UpdateMessageKey {
  switch (state.phase) {
    case "checking": return "update.checking";
    case "downloading": return "update.downloading";
    case "ready": return "update.restart";
    case "available": return "update.download";
    default: return "update.check";
  }
}

/**
 * One line describing the state, as a message and the values that fill it.
 *
 * A key rather than a sentence: the phase is decided here, where the state is, and the wording
 * belongs to whichever language the window is being read in.
 */
export function describe(state: UpdateState): { key: UpdateMessageKey; vars?: Record<string, string | number> } {
  switch (state.phase) {
    case "unsupported": return { key: "update.state.unsupported" };
    case "checking": return { key: "update.state.checking" };
    case "downloading":
      return {
        key: "update.state.downloading",
        vars: { version: state.latest ?? "", percent: Math.round(state.percent) },
      };
    case "ready": return { key: "update.state.ready", vars: { version: state.latest ?? "" } };
    case "available": return { key: "update.state.available", vars: { version: state.latest ?? "" } };
    // The failure is git's or the network's own words, which no dictionary has; it is passed
    // through as the message itself rather than translated into a vaguer sentence.
    case "failed": return state.error
      ? { key: "update.state.failedWith", vars: { reason: state.error } }
      : { key: "update.state.failed" };
    case "current": return { key: "update.state.current", vars: { version: state.current } };
    default: return { key: "update.state.idle", vars: { version: state.current } };
  }
}
