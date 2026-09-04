/**
 * Both ends of a contract, built from it.
 *
 * `buildApi` is what the preload exposes; `wire` is what a feature's main side registers through.
 * Electron is injected into both rather than imported, so this file compiles everywhere the
 * contracts do and is tested with a fake — which is also how the exposed surface gets pinned.
 */
import type { Api, Contract, Event, Handlers } from "./contract.js";

/** The slice of `ipcRenderer` the page side needs. */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** `window.hangar` for one contract. Merge several with a spread; names must not collide. */
export function buildApi<C extends Contract>(contract: C, ipc: RendererIpc): Api<C> {
  const api: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(contract)) {
    if (spec.kind === "invoke") {
      api[name] = (payload?: unknown) => ipc.invoke(spec.channel, payload);
    } else if (spec.kind === "send") {
      api[name] = (payload: unknown) => ipc.send(spec.channel, payload);
    } else {
      // The subscription shape the hand-written bridge repeated six times over.
      api[name] = (listener: (value: unknown) => void) => {
        const handler = (_event: unknown, value: unknown): void => listener(value);
        ipc.on(spec.channel, handler);
        return () => ipc.removeListener(spec.channel, handler);
      };
    }
  }
  return api as Api<C>;
}

/** The slice of `ipcMain` the main side needs. */
export interface MainIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * The plumbing a feature registers through — deliberately not part of the context, which holds
 * shared STATE. Every feature needs these two; none of them owns them.
 */
export interface Wire {
  /** Bind this contract's handlers. The types force one handler per invoke/send channel. */
  bind<C extends Contract>(contract: C, handlers: Handlers<C>): void;
  /** Push an event this contract declares. */
  emit<P>(ev: Event<P>, value: P): void;
}

export function wire(ipc: MainIpc, push: (channel: string, value: unknown) => void): Wire {
  return {
    bind(contract, handlers) {
      const table = handlers as Record<string, (payload: unknown) => unknown>;
      for (const [name, spec] of Object.entries(contract)) {
        const handler = table[name];
        if (!handler) continue;                      // events have no handler: main sends them
        if (spec.kind === "invoke") ipc.handle(spec.channel, (_event, payload) => handler(payload));
        else if (spec.kind === "send") ipc.on(spec.channel, (_event, payload) => void handler(payload));
      }
    },
    emit(ev, value) {
      push(ev.channel, value);
    },
  };
}

/** Every key of the exposed surface with its shape — what the surface test pins. */
export function surfaceOf(contract: Contract): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(contract)) out[name] = `${spec.kind} ${spec.channel}`;
  return out;
}
