"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { presetIssues, type Preset } from "../../lib/try/presets";
import { noticeFor, submitTry, type Notice as NoticeCopy } from "../../components/app/api";
import { AuthorBudget, useAuthor } from "../../components/app/AuthorBudget";
import { Notice } from "../../components/app/Notice";
import { RunTimeline } from "../../components/app/RunTimeline";
import { useRunPolling } from "../../components/app/useRunPolling";
import { WaveColumn } from "../../components/app/WaveColumn";
import type { Watch } from "./watch";

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

const CHIPS: Array<{ id: Preset; label: string; hint: string }> = [
  { id: "injection", label: "Hidden instruction", hint: "A bug report with an instruction hidden in an HTML comment" },
  { id: "duplicate", label: "Duplicate", hint: "A report of a problem the repository already tracks" },
  { id: "repro", label: "Python bug", hint: "A bug report with a Python snippet Porter can run in the sandbox" },
  { id: "spam", label: "Spam wave (12 issues)", hint: "Twelve low-effort issues from one author, filed together" },
];

function SingleRun({ id }: { id: string }) {
  const { runs, errors, done, paused } = useRunPolling([id]);
  const d = runs[id];
  const err = errors[id];
  const author = useAuthor(d?.run.authorExternalId ?? null, !done);
  return (
    <>
      {err && !d && <Notice notice={noticeFor(err, "read")} tone="warn" />}
      {paused && <p className="muted small">Updates resume when this tab is visible.</p>}
      <RunTimeline detail={err && !d ? undefined : d} mode="compact" />
      {d && <AuthorBudget id={d.run.authorExternalId} author={author} />}
      <p className="desk-links">
        <Link href={`/console/runs/${id}`} className="btn btn-sm btn-g">
          Open the full trace
        </Link>
      </p>
    </>
  );
}

function Wave({ ids }: { ids: string[] }) {
  const { runs, done, paused } = useRunPolling(ids, { perTick: 3 });
  const authorId = ids.map((id) => runs[id]?.run.authorExternalId).find((a): a is string => !!a) ?? null;
  const author = useAuthor(authorId, !done);
  return (
    <>
      {paused && <p className="muted small">Updates resume when this tab is visible.</p>}
      <AuthorBudget id={authorId} author={author} />
      <WaveColumn ids={ids} runs={runs} author={author} />
      {done && <p className="muted small">All twelve are final. Open any row for its full trace.</p>}
    </>
  );
}

export function TryDesk({ initial }: { initial: Watch }) {
  const [preset, setPreset] = useState<Preset | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeCopy | null>(null);
  const [watch, setWatch] = useState<Watch>(initial);

  const spam = preset === "spam";
  const presetText = preset && !spam ? presetIssues(preset)[0] : null;
  const asPreset = spam || (presetText !== null && presetText.title === title && presetText.body === body);

  const pick = (p: Preset) => {
    setNotice(null);
    if (preset === p) {
      setPreset(null);
      return;
    }
    setPreset(p);
    if (p !== "spam") {
      const issue = presetIssues(p)[0];
      setTitle(issue.title);
      setBody(issue.body);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!spam && title.trim() === "") {
      setNotice({ title: "Add a title", body: "An issue needs a title. The body can stay empty." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const r = await submitTry(asPreset && preset ? { preset } : { title, body });
    setBusy(false);
    if (!r.ok) {
      setNotice(noticeFor(r, "try"));
      return;
    }
    const next: Watch = r.data.runIds ? { kind: "wave", ids: r.data.runIds } : r.data.runId ? { kind: "run", id: r.data.runId } : null;
    setWatch(next);
    if (next) {
      const q = next.kind === "wave" ? `wave=${next.ids.join(",")}` : `run=${next.id}`;
      window.history.replaceState(null, "", `/try?${q}`);
    }
  };

  const reset = () => {
    setWatch(null);
    setNotice(null);
    window.history.replaceState(null, "", "/try");
  };

  return (
    <div className="try-grid" data-watching={watch ? "" : undefined}>
      <section className="try-form" aria-labelledby="compose-title">
        <h2 id="compose-title" className="panel-title">
          Your issue
        </h2>
        <form onSubmit={submit} noValidate>
          <fieldset className="chips">
            <legend>Start from an example</legend>
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={preset === c.id}
                onClick={() => pick(c.id)}
                title={c.hint}
              >
                {c.label}
              </button>
            ))}
          </fieldset>

          {spam ? (
            <div className="spam-list">
              <p>Twelve issues from one visitor, filed together and run one after another:</p>
              <ol>
                {presetIssues("spam").map((i, n) => (
                  <li key={n}>{i.title}</li>
                ))}
              </ol>
            </div>
          ) : (
            <>
              <label className="field">
                <span>Title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_TITLE} required autoComplete="off" />
              </label>
              <label className="field">
                <span>
                  Body <em>Markdown, optional</em>
                </span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={MAX_BODY} rows={11} spellCheck={false} />
              </label>
              {preset === "injection" && asPreset && (
                <p className="field-note">The HTML comment would be invisible on GitHub. The gateway reads the raw text.</p>
              )}
            </>
          )}

          {notice && <Notice notice={notice} tone="warn" />}

          <div className="form-foot">
            <button type="submit" className="btn btn-p" disabled={busy}>
              {busy ? "Filing…" : spam ? "File 12 issues" : "File the issue"}
            </button>
            <p className="fine">
              Filed as an anonymous visitor with its own daily budget. Porter keeps a daily hash of your address, never the address. Nothing is
              posted to GitHub.
            </p>
          </div>
        </form>
      </section>

      <section className="try-desk" aria-labelledby="desk-title">
        <div className="panel-head">
          <h2 id="desk-title" className="panel-title">
            {watch?.kind === "wave" ? "The wave, as the gateway sees it" : "What Porter did"}
          </h2>
          {watch && (
            <button type="button" className="btn btn-sm btn-g" onClick={reset}>
              New issue
            </button>
          )}
        </div>
        {watch === null ? (
          <div className="empty">
            <p className="empty-title">File an issue to watch it go through the gateway.</p>
            <p>Each call appears as it happens: the guard verdicts, the model Otari served, what it cost, and the reply.</p>
          </div>
        ) : watch.kind === "run" ? (
          <SingleRun key={watch.id} id={watch.id} />
        ) : (
          <Wave key={watch.ids.join(",")} ids={watch.ids} />
        )}
      </section>
    </div>
  );
}
