import { useSyncExternalStore } from "react";

/** One ticker for the whole page, rather than a timer per card. */
const subscribe = (notify: () => void) => {
  const id = setInterval(notify, 60_000);
  return () => clearInterval(id);
};

/** Rounded to the minute so the snapshot is stable between renders. */
const getSnapshot = () => Math.floor(Date.now() / 60_000) * 60_000;

/**
 * The current time, as a value React is allowed to read during render.
 *
 * `Date.now()` called inline is impure: it makes a component render
 * differently on the server and on the client, which React reports as a
 * hydration mismatch. `useSyncExternalStore` solves both halves — it returns
 * `0` during server rendering (callers treat that as "unknown" and render
 * nothing time-dependent) and a real, minute-stable timestamp afterwards.
 */
export const useNow = (): number =>
  useSyncExternalStore(subscribe, getSnapshot, () => 0);
