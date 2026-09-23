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

/**
 * Whether the viewport is at least `px` wide. False on the server and until
 * mounted. For layouts that must add or remove structure (table columns)
 * rather than restyle it, where a CSS-hidden element would still take space.
 */
export function useMinWidth(px: number) {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const update = () => setMatch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [px]);
  return match;
}
