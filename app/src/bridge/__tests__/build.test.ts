import { describe, expect, it } from "vitest";

import { buildApi, surfaceOf, wire, type MainIpc, type RendererIpc } from "../build.js";
import { event, invoke, send } from "../contract.js";
import { CONTRACTS } from "../registry.js";

/** A contract with one of each shape, so every branch of the builder is exercised. */
const sample = {
  ask: invoke<{ id: string }, number>("t:ask"),
  ping: invoke<void, string>("t:ping"),
  nudge: send<{ by: number }>("t:nudge"),
  onTick: event<number>("t:tick"),
} as const;

function fakeRenderer(): RendererIpc & { calls: string[]; listeners: Map<string, Set<(...a: unknown[]) => void>> } {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    calls,
    listeners,
    invoke: async (channel, ...args) => { calls.push(`invoke ${channel} ${JSON.stringify(args)}`); return 42; },
    send: (channel, ...args) => { calls.push(`send ${channel} ${JSON.stringify(args)}`); },
    on: (channel, listener) => { (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel))!.add(listener); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  };
}

describe("buildApi", () => {
  it("turns an invoke into a promise-returning call with one payload", async () => {
    const ipc = fakeRenderer();
    const api = buildApi(sample, ipc);
    expect(await api.ask({ id: "a" })).toBe(42);
    expect(await api.ping()).toBe(42);
    expect(ipc.calls).toEqual([`invoke t:ask [{"id":"a"}]`, "invoke t:ping [null]"]);
  });

  it("turns a send into fire-and-forget", () => {
    const ipc = fakeRenderer();
    buildApi(sample, ipc).nudge({ by: 3 });
    expect(ipc.calls).toEqual([`send t:nudge [{"by":3}]`]);
  });

  it("turns an event into subscribe-and-unsubscribe, passing only the value", () => {
    const ipc = fakeRenderer();
    const api = buildApi(sample, ipc);
    const seen: number[] = [];
    const off = api.onTick((n) => seen.push(n));
    for (const l of ipc.listeners.get("t:tick") ?? []) l({}, 7);
    off();
    expect(seen).toEqual([7]);
    expect(ipc.listeners.get("t:tick")?.size).toBe(0);
  });
});

describe("wire", () => {
  it("binds one handler per invoke and send, and pushes events on the declared channel", async () => {
    const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc: MainIpc = {
      handle: (channel, listener) => { handled.set(`handle ${channel}`, listener); },
      on: (channel, listener) => { handled.set(`on ${channel}`, listener); },
    };
    const pushed: [string, unknown][] = [];
    const w = wire(ipc, (channel, value) => pushed.push([channel, value]));

    w.bind(sample, {
      ask: ({ id }) => id.length,
      ping: () => "pong",
      nudge: () => undefined,
    });
    expect([...handled.keys()].sort()).toEqual(["handle t:ask", "handle t:ping", "on t:nudge"]);
    expect(await handled.get("handle t:ask")!({}, { id: "abc" })).toBe(3);

    w.emit(sample.onTick, 9);
    expect(pushed).toEqual([["t:tick", 9]]);
  });
});

/**
 * The exposed surface, pinned.
 *
 * The hand-written bridge could be read top to bottom to see everything the page may do. A derived
 * one cannot, so this is where that reading happens: every key and its shape. An addition that is
 * not meant to be here fails this test instead of quietly widening what the page can reach.
 */
describe("the surface the page can reach", () => {
  it("is exactly this", () => {
    expect(surfaceOf(CONTRACTS)).toEqual({
      scan: "invoke projects:scan",
      openSession: "invoke session:open",
      renameSession: "invoke session:rename",
      renameProject: "invoke project:rename",
      deleteSession: "invoke session:delete",
      deleteProject: "invoke project:delete",
      revealProject: "invoke project:reveal",
      addProject: "invoke project:add",
      togglePin: "invoke pin:toggle",
      updateAction: "invoke update:action",
      onUpdate: "event update:push",
      gitCount: "invoke git:count",
      gitSync: "invoke git:sync",
      worktreeList: "invoke worktree:list",
      worktreeAdd: "invoke worktree:add",
      worktreeRemove: "invoke worktree:remove",
      status: "invoke status:read",
      setUsageHook: "invoke usage:hook",
      metrics: "invoke metrics:history",
      onMetrics: "event metrics:push",
      pasteImage: "invoke clipboard:paste-image",
      onPasteResult: "event clipboard:paste-result",
      displays: "invoke settings:displays",
      applyDock: "invoke dock:apply",
      dragDock: "send dock:drag",
      releaseDock: "invoke dock:release",
      dockToggle: "invoke dock:toggle",
      dockState: "invoke dock:state",
      onDockState: "event dock:state-push",
    });
  });

  it("has no two features claiming one name", () => {
    // A spread would silently keep the last one; the registry must stay collision-free.
    const names = Object.keys(CONTRACTS);
    expect(new Set(names).size).toBe(names.length);
  });
});
