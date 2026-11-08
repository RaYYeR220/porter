import type { Metadata } from "next";
import { ShadowReport } from "../../../components/evidence/ShadowReport";
import { loadShadowReport } from "../../../lib/site/results";
import "../../app.css";
import "../../evidence.css";

export const metadata: Metadata = {
  title: "Otari report",
  description:
    "Porter's read-only triage of open issues on mozilla-ai/otari: kinds, possible duplicates, likely fixes and missing information, each claim marked with whether a person has checked it.",
};

/** Read from results/shadow-otari.json when the page is built; nothing here posts anywhere. */
export default function OtariReportPage() {
  return <ShadowReport loaded={loadShadowReport()} />;
}
