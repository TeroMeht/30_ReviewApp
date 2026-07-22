"use client";

/**
 * Small hook: track the pixel width of a DOM element via ResizeObserver.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   const width = useContainerWidth(ref, 960); // fallback until measured
 *   return <div ref={ref} style={{ width: "100%" }}>{width}px</div>;
 *
 * The fallback is used until the first ResizeObserver callback fires
 * (a single frame). We round to integer pixels to avoid sub-pixel
 * churn triggering unnecessary re-renders.
 */

import { useEffect, useState, type RefObject } from "react";

export function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const [width, setWidth] = useState<number>(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seed with the current measurement so the first paint uses the
    // correct width whenever possible.
    const seed = Math.round(el.getBoundingClientRect().width);
    if (seed > 0) setWidth(seed);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
