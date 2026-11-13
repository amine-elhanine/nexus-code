// Physical chat transcript shell (Phase 2 unification) — THE scroll container
// for all three chat areas (Code, Home, Notebook).
//
// Each view previously owned a private stick-to-bottom manager + autoscroll
// effect + lazy-visual observer; the three copies had drifted (Code respected
// the stick flag everywhere, Notebook pinned unconditionally and yanked the
// reader, Home smooth-scrolled through a bottom anchor). This component owns
// the whole scroll contract:
// - stick-to-bottom only while the user is already near the bottom (240px)
// - autoscroll re-pins on `scrollKey` changes (counts / streamed text)
// - lazy visuals (images, charts, diagrams) re-pin on load/resize via the
//   shared `nexus:chat-image-loaded` event + a mount-only ResizeObserver that
//   tracks late-mounted children with a MutationObserver (never rebuilt per
//   streamed token)
//
// Views keep their internals; they pass their existing ref via
// `transcriptRef` so their other behaviors (scrollToBottom, tooltips,
// measuring) keep working unchanged.

import React, { useEffect, useRef } from "react";

export type ChatShellProps = {
  className?: string;
  /** Autoscroll trigger signature — changes re-pin the view (when stuck). */
  scrollKey: string | number;
  /** Pass an existing ref so the view can keep measuring the element. */
  transcriptRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Pass an existing stick flag so the view can force-pin (e.g. before submit). */
  stickRef?: React.MutableRefObject<boolean>;
  children: React.ReactNode;
};

const STICK_THRESHOLD_PX = 240;

export function ChatShell({ className, scrollKey, transcriptRef: externalRef, stickRef: externalStick, children }: ChatShellProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const innerStick = useRef(true);
  const ref = externalRef ?? innerRef;
  const stickRef = externalStick ?? innerStick;

  // Reader is in charge: scrolling up unpins, returning near the bottom pins.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  // Re-pin on content changes (new messages, streamed tokens, run state).
  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollKey, ref]);

  // Lazy visual content: images/charts/diagrams load or resize after the
  // message row mounts. Mount-ONLY wiring: a ResizeObserver on the container
  // + observed children, with a MutationObserver tracking late-mounted
  // children (observe is idempotent per element), so nothing is rebuilt per
  // streamed token.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleImageLoaded = () => {
      if (stickRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    };
    window.addEventListener("nexus:chat-image-loaded", handleImageLoaded);

    let prevHeight = el.scrollHeight;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        // The stick flag is the only scroll authority — resizing content must
        // never override a deliberate scroll.
        if (stickRef.current && el.scrollHeight !== prevHeight) {
          el.scrollTop = el.scrollHeight;
        }
        prevHeight = el.scrollHeight;
      });
      observer.observe(el);
      Array.from(el.children).forEach((child) => observer?.observe(child));
    }
    let childObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      childObserver = new MutationObserver(() => {
        if (!observer) return;
        for (const child of Array.from(el.children)) observer.observe(child);
      });
      childObserver.observe(el, { childList: true });
    }

    return () => {
      window.removeEventListener("nexus:chat-image-loaded", handleImageLoaded);
      observer?.disconnect();
      childObserver?.disconnect();
    };
  }, [ref]);

  return (
    <div className={className} ref={ref as React.RefObject<HTMLDivElement>} onScroll={onScroll}>
      {children}
    </div>
  );
}
