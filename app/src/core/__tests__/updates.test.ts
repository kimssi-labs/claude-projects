/**
 * Core: when an update check is allowed to go out, and what the screen says about it.
 *
 * The interesting cases are the ones that waste a request or lie to the reader: a second check on
 * top of one already running, a timer firing for someone who turned automatic checks off, and a
 * click that should still work when the timer would have declined.
 */
import { describe, expect, it } from "vitest";

import {
  actionLabel, describe as describeState, initialState, MIN_CHECK_GAP_MS, shouldCheck,
  type UpdateState,
} from "../updates.js";
import { en } from "../locales/en.js";

const NOW = 1_700_000_000_000;
const AUTO = { automatic: true };
const MANUAL_ONLY = { automatic: false };

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return { ...initialState("2.7.0", true), ...overrides };
}

describe("shouldCheck", () => {
  it("checks on a timer when automatic checks are on, and not when they are off", () => {
    expect(shouldCheck(state(), { manual: false, now: NOW, config: AUTO })).toBe(true);
    expect(shouldCheck(state(), { manual: false, now: NOW, config: MANUAL_ONLY })).toBe(false);
  });

  it("still checks on a click when the timer is off — that is what the button is for", () => {
    expect(shouldCheck(state(), { manual: true, now: NOW, config: MANUAL_ONLY })).toBe(true);
  });

  it("never runs a second check on top of one in flight", () => {
    for (const phase of ["checking", "downloading"] as const) {
      expect(shouldCheck(state({ phase }), { manual: true, now: NOW, config: AUTO })).toBe(false);
    }
  });

  it("stops checking once an update is downloaded — the next step is a restart", () => {
    expect(shouldCheck(state({ phase: "ready", latest: "2.8.0" }), { manual: true, now: NOW, config: AUTO }))
      .toBe(false);
  });

  it("holds a repeated click to one request a minute, then allows the next", () => {
    const justChecked = state({ phase: "current", checkedAt: NOW });
    expect(shouldCheck(justChecked, { manual: true, now: NOW + 1_000, config: AUTO })).toBe(false);
    expect(shouldCheck(justChecked, { manual: true, now: NOW + MIN_CHECK_GAP_MS, config: AUTO })).toBe(true);
  });

  it("declines everything in a build that cannot update itself", () => {
    const portable = initialState("2.7.0", false);
    expect(portable.phase).toBe("unsupported");
    expect(shouldCheck(portable, { manual: true, now: NOW, config: AUTO })).toBe(false);
  });
});

describe("what the screen says", () => {
  // The wording lives in the dictionaries now; this module decides which message and with what.
  it("names the version in every phase that has one", () => {
    expect(describeState(state({ phase: "current" })))
      .toEqual({ key: "update.state.current", vars: { version: "2.7.0" } });
    expect(describeState(state({ phase: "available", latest: "2.8.0" })))
      .toEqual({ key: "update.state.available", vars: { version: "2.8.0" } });
    expect(describeState(state({ phase: "ready", latest: "2.8.0" })))
      .toEqual({ key: "update.state.ready", vars: { version: "2.8.0" } });
    expect(describeState(state({ phase: "downloading", latest: "2.8.0", percent: 41.6 })))
      .toEqual({ key: "update.state.downloading", vars: { version: "2.8.0", percent: 42 } });
  });

  it("gives the reason a check failed rather than a shrug", () => {
    // The reason is the network's own words, which no dictionary carries; it passes through.
    expect(describeState(state({ phase: "failed", error: "net::ERR_INTERNET_DISCONNECTED" })))
      .toEqual({ key: "update.state.failedWith", vars: { reason: "net::ERR_INTERNET_DISCONNECTED" } });
    expect(describeState(state({ phase: "failed" }))).toEqual({ key: "update.state.failed" });
  });

  it("labels the button with the next thing that will happen", () => {
    expect(actionLabel(state())).toBe("update.check");
    expect(actionLabel(state({ phase: "available" }))).toBe("update.download");
    expect(actionLabel(state({ phase: "ready" }))).toBe("update.restart");
    expect(actionLabel(state({ phase: "checking" }))).toBe("update.checking");
  });

  it("names only messages the dictionaries actually define", () => {
    // A key with no entry would print itself on screen; every phase is checked against English.
    const phases = ["idle", "checking", "current", "available", "downloading", "ready", "failed", "unsupported"] as const;
    for (const phase of phases) {
      expect(en).toHaveProperty(describeState(state({ phase })).key);
      expect(en).toHaveProperty(actionLabel(state({ phase })));
    }
  });
});
