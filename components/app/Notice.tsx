import type { ReactNode } from "react";
import type { Notice as NoticeCopy } from "./api";

/** A calm, specific message in place of a raw error. */
export function Notice({ notice, tone = "info", children }: { notice: NoticeCopy; tone?: "info" | "warn"; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      <p className="notice-title">{notice.title}</p>
      <p>{notice.body}</p>
      {children}
    </div>
  );
}
