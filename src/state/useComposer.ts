// Shared composer primitives for the three chat areas (Home, Code, Notebook).
//
// The autosize effect and same-tick submit guard existed in two or three
// private copies that had already drifted (min/max heights differed per view,
// Code lacked the double-submit guard entirely, Notebook got one only after
// the 2026-11-12 review) — one implementation here.

import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Auto-resize a textarea to its content between `min` and `max` px, re-running
 * whenever `value` changes. Per-view min/max stay parameters so each surface
 * keeps its tuned dimensions.
 */
export function useAutosizeTextarea(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { min = 26, max = 180 }: { min?: number; max?: number } = {}
): void {
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${nextHeight}px`;
  }, [textareaRef, value, min, max]);
}

export type InflightGuard = {
  /** True while a submit for this key is in flight (same event tick included). */
  has: (key: string) => boolean;
  start: (key: string) => void;
  end: (key: string) => void;
};

/**
 * Same-tick double-submit guard. React state ("running"/"asking") is set
 * asynchronously, so a double Enter inside one event tick passes a state-only
 * check twice — the backend rejects the twin run, but the optimistic user
 * message would already duplicate in the transcript. Keys are session/chat
 * ids; "__new__"-style sentinels cover the not-yet-created-entity paths.
 */
export function useInflightGuard(): InflightGuard {
  const inflight = useRef<Set<string>>(new Set());
  const has = useCallback((key: string) => inflight.current.has(key), []);
  const start = useCallback((key: string) => {
    inflight.current.add(key);
  }, []);
  const end = useCallback((key: string) => {
    inflight.current.delete(key);
  }, []);
  return { has, start, end };
}
