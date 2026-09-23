import { useEffect, useRef, useState } from "react";

/**
 * The current time, resolved only after mount and refreshed on an interval.
 * Anything that positions or labels itself relative to "now" (the horizon,
 * passage progress, the date line) would otherwise render differently on the
 * server and in the browser and fail hydration. `null` until mounted.
 */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Rendered pixel width of an element, tracked with a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
