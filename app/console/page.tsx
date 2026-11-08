import type { Metadata } from "next";
import { Console } from "./Console";
import "../app.css";

export const metadata: Metadata = {
  title: "Console",
  description: "The maintainer's desk: every run Porter made, what the gateway held or refused, proposals waiting for approval, and each author's budget.",
};

export default function ConsolePage() {
  return (
    <div className="wrap app">
      <header className="app-head">
        <h1>Console</h1>
        <p>
          What Porter did with each issue, what the gateway held or refused, and every stranger’s budget. Open to anyone for the demo, so actions
          are limited per address.
        </p>
      </header>
      <Console />
    </div>
  );
}
