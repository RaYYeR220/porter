import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunTrace } from "./RunTrace";
import "../../../app.css";

export const metadata: Metadata = {
  title: "Run trace",
  description: "Every gateway call Porter made for one issue: the model served, guard verdicts, tools, cost and the reply.",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return (
    <div className="wrap app app-trace">
      <RunTrace id={id.toLowerCase()} />
    </div>
  );
}
