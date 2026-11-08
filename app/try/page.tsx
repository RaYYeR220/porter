import type { Metadata } from "next";
import { TryDesk } from "./TryDesk";
import { watchFrom } from "./watch";
import "../app.css";

export const metadata: Metadata = {
  title: "Try it",
  description: "File a test issue as a stranger and watch Porter screen it at the gateway, budget it and answer it on open-weight models.",
};

export default async function TryPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const initial = watchFrom(await searchParams);
  return (
    <div className="wrap app">
      <header className="app-head">
        <h1>File an issue as a stranger.</h1>
        <p>
          No account needed. Your issue takes the same path as one opened on GitHub: screened at the gateway before a model sees it, answered on
          open-weight models from your own daily budget, and refused once that budget is spent.
        </p>
      </header>
      <TryDesk initial={initial} />
    </div>
  );
}
