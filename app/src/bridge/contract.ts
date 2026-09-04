/**
 * What a feature promises across the process boundary, declared once.
 *
 * A contract is a record of channels. Each channel is one of three shapes — the whole of today's
 * preload counted as 31 `invoke`, 6 events and 1 `send`, and nothing else — and from that record
 * both ends are derived: the page's `window.hangar` entries and the types the main-side handlers
 * must satisfy. Add a channel here and both ends are typed at once; there is no second file to
 * forget.
 *
 * This file imports nothing from electron on purpose: it is compiled into the main process, the
 * preload and the renderer alike, and it is the only kind of file a feature may share between them.
 */

/** The page asks and waits for an answer. */
export interface Invoke<P, R> { readonly kind: "invoke"; readonly channel: string; readonly __p?: P; readonly __r?: R }
/** The page tells, and does not wait. */
export interface Send<P> { readonly kind: "send"; readonly channel: string; readonly __p?: P }
/** Main tells the page, whenever it likes. */
export interface Event<P> { readonly kind: "event"; readonly channel: string; readonly __p?: P }

export type Channel = Invoke<unknown, unknown> | Send<unknown> | Event<unknown>;
export type Contract = Record<string, Channel>;

// The `__p` / `__r` members never exist at runtime; they carry the payload and result types so
// the mapped types below can read them back out of a plain object literal.
export const invoke = <P = void, R = void>(channel: string): Invoke<P, R> => ({ kind: "invoke", channel });
export const send = <P>(channel: string): Send<P> => ({ kind: "send", channel });
export const event = <P>(channel: string): Event<P> => ({ kind: "event", channel });

/** `window.hangar`, as a contract implies it. */
export type Api<C extends Contract> = {
  [K in keyof C]:
    C[K] extends Invoke<infer P, infer R>
      ? [P] extends [void] ? () => Promise<R> : (payload: P) => Promise<R>
      : C[K] extends Send<infer P> ? (payload: P) => void
        : C[K] extends Event<infer P> ? (listener: (value: P) => void) => () => void
          : never;
};

/** What a feature's main side has to supply: one function per channel the page can start. */
export type Handlers<C extends Contract> = {
  [K in keyof C as C[K] extends Invoke<unknown, unknown> | Send<unknown> ? K : never]:
    C[K] extends Invoke<infer P, infer R> ? (payload: P) => R | Promise<R>
      : C[K] extends Send<infer P> ? (payload: P) => void
        : never;
};
