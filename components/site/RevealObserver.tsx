"use client";

import { useEffect } from "react";

/**
 * Adds .in to each .reveal element as it scrolls into view. The CSS shows them anyway after a few seconds
 * (reveal-failsafe), so a missed observer never leaves content hidden.
 */
export function RevealObserver() {
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>(".reveal:not(.in)")];
    if (typeof IntersectionObserver !== "function") {
      for (const el of els) el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { threshold: 0.15 },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);
  return null;
}
