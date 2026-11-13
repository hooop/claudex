import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { useScreenVisible } from "../screenVisibility.js";
import type { MouseEvent } from "./mouseInput.js";

type MouseSource = { on(listener: (event: MouseEvent) => void): () => void };

const MouseContext = createContext<MouseSource | null>(null);

/** Makes the filtered stdin's mouse events available to `useMouse`. */
export function MouseProvider(props: { source: MouseSource | null; children: ReactNode }) {
  return <MouseContext.Provider value={props.source}>{props.children}</MouseContext.Provider>;
}

/**
 * Calls `handler` for every mouse event while `active`. The latest handler is
 * always the one called, so passing a fresh closure on each render does not
 * resubscribe. Without a provider (tests, the welcome screen) it does nothing.
 */
export function useMouse(handler: (event: MouseEvent) => void, active: boolean): void {
  const source = useContext(MouseContext);
  // A hidden screen gets no mouse events, like it gets no keys.
  const listening = useScreenVisible() && active;
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!source || !listening) return;
    return source.on((event) => handlerRef.current(event));
  }, [source, listening]);
}
