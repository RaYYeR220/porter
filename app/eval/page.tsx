import type { Metadata } from "next";
import { EvalReport } from "../../components/evidence/EvalReport";
import { corpusSummary, loadEvalResults, loadPostHoc, loadShadowReport } from "../../lib/site/results";
import "../app.css";
import "../evidence.css";

export const metadata: Metadata = {
  title: "Eval",
  description:
    "25 attacks and 25 real issues, run through the same bot twice: with prompt-only defences and as Porter on Otari. Where each attack stopped, the spam wave, and the method fixed before the first run.",
};

/** Read from results/ when the page is built; a missing file renders as "Not run yet". Post-hoc runs come last. */
export default function EvalPage() {
  return <EvalReport results={loadEvalResults()} corpus={corpusSummary()} postHoc={loadPostHoc()} shadow={loadShadowReport()} />;
}
