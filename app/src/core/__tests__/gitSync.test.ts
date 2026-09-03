/**
 * Core: what "update from the base branch" resolves to, and what its outcome means.
 *
 * The classification matters more than it looks. Half of these outcomes are the user's turn rather
 * than a fault, and an update that reports "failed" for an unclean working tree sends someone
 * looking for a bug that is not there.
 */
import { describe, expect, it } from "vitest";

import {
  classify, defaultBaseFrom, fetchArgs, reconcileArgs, splitBase, syncLabel,
} from "../gitSync.js";

describe("resolving the base", () => {
  it("splits a remote branch into its remote and its branch", () => {
    expect(splitBase("origin/main", ["origin"])).toEqual({ remote: "origin", branch: "main" });
    expect(splitBase("upstream/release/2.x", ["origin", "upstream"]))
      .toEqual({ remote: "upstream", branch: "release/2.x" });
  });

  it("takes the longest matching remote, which is the one that actually owns the ref", () => {
    // Both are real remotes; "origin" would claim the ref and leave branch "mirror/main".
    expect(splitBase("origin/mirror/main", ["origin", "origin/mirror"]))
      .toEqual({ remote: "origin/mirror", branch: "main" });
  });

  it("accepts the fully qualified spellings git itself prints", () => {
    expect(splitBase("refs/remotes/origin/main", ["origin"])).toEqual({ remote: "origin", branch: "main" });
    expect(splitBase("remotes/origin/main", ["origin"])).toEqual({ remote: "origin", branch: "main" });
  });

  it("refuses anything that is not a branch on a known remote", () => {
    expect(splitBase("main", ["origin"])).toBeNull();               // a local branch is not a base
    expect(splitBase("origin", ["origin"])).toBeNull();             // the remote alone names nothing
    expect(splitBase("", ["origin"])).toBeNull();
    // A value that starts with a dash would be read by git as an option, not a ref.
    expect(splitBase("--upload-pack=evil", ["origin"])).toBeNull();
  });

  it("reads the remote's own default out of a symbolic ref", () => {
    expect(defaultBaseFrom("refs/remotes/origin/main\n")).toBe("origin/main");
    expect(defaultBaseFrom("")).toBe("");
  });
});

describe("the commands", () => {
  it("fetches into a private ref as well as the tracking branch", () => {
    // The private ref is what the rebase then uses: a second fetch anywhere in the repository can
    // move the tracking ref between the two steps.
    expect(fetchArgs("origin", "main", "refs/hangar/base/xyz")).toEqual([
      "fetch", "origin",
      "+refs/heads/main:refs/hangar/base/xyz",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  it("uses the command the chosen strategy actually means", () => {
    expect(reconcileArgs("rebase", "REF")).toEqual(["rebase", "REF"]);
    // --no-rebase explicitly: a user with pull.rebase set would otherwise get a rebase from "merge".
    expect(reconcileArgs("merge", "REF")).toEqual(["merge", "--no-rebase", "REF"]);
    expect(reconcileArgs("ff-only", "REF")).toEqual(["merge", "--ff-only", "REF"]);
  });

  it("names the branch in the menu entry, and stays sensible without one", () => {
    expect(syncLabel("origin/main")).toBe("Update from origin/main");
    expect(syncLabel("")).toBe("Update from the base branch");
  });
});

describe("classifying the outcome", () => {
  it("tells an update that did something from one that had nothing to do", () => {
    expect(classify(0, "Already up to date.")).toEqual({ ok: true, kind: "current" });
    expect(classify(0, "Successfully rebased and updated refs/heads/feature."))
      .toEqual({ ok: true, kind: "updated" });
  });

  it("calls the user's turn the user's turn, not a failure", () => {
    expect(classify(1, "CONFLICT (content): Merge conflict in src/a.ts").kind).toBe("conflict");
    expect(classify(1, "error: Your local changes to the following files would be overwritten by merge:").kind)
      .toBe("dirty");
    expect(classify(128, "fatal: Not possible to fast-forward, aborting.").kind).toBe("diverged");
  });

  it("says the remote was unreachable rather than quoting a URL error", () => {
    const outcome = classify(128, "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host");
    expect(outcome).toEqual({ ok: false, kind: "offline", message: "Could not reach the remote." });
  });

  it("falls back to git's own last line when it is something else entirely", () => {
    expect(classify(1, "fatal: refusing to merge unrelated histories\n"))
      .toEqual({ ok: false, kind: "failed", message: "fatal: refusing to merge unrelated histories" });
  });
});
