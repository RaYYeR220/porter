"use client";

import { useEffect, useRef } from "react";
import { heroData } from "./data";
import type { HeroData } from "./data";
import { mountField } from "./mount";

export const FIELD_LABEL =
  "Columns of real issue text rise toward one gateway line. Ordinary characters pass through and settle; " +
  "hidden payload characters catch on the line and the column is held; one author's column thins out, then stops short, refused.";

/** The landing hero's living object. Fills its parent; the parent sets the size. */
export function GlyphGate({ data = heroData }: { data?: HeroData }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    return mountField(canvas, data);
  }, [data]);

  return <canvas ref={ref} className="field" role="img" aria-label={FIELD_LABEL} data-motion="pending" />;
}
