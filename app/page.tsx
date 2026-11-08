import Link from "next/link";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { GlyphGate } from "../components/hero/GlyphGate";
import { RevealObserver } from "../components/site/RevealObserver";
import { openIssueHref } from "../components/site/links";
import { readAttackFigures } from "../lib/site/eval-figures";
import "./landing.css";

const STACK = ["gpt-oss-120b", "Qwen3Guard", "Llama Guard 4", "Qwen3-Embedding"];

/** What a stranger's issue touches, named in plain words, with the real identifiers underneath. */
const RUNS: Array<{ name: string; what: string; ids: string }> = [
  {
    name: "Per-author budgets",
    what: "Each stranger spends from their own daily allowance. Past 80% their issues go to a smaller model; at 100% the gateway refuses them until midnight UTC.",
    ids: "end-user budgets · newcomer · regular",
  },
  {
    name: "Guardrails at the gateway",
    what: "Otari sends every issue to Porter’s guard before an answering model sees it. A held issue gets a fixed reply and waits for a maintainer.",
    ids: "porter-guard · prompt-injection · secrets · harm",
  },
  {
    name: "Read-only tools for strangers",
    what: "A stranger’s issue can search issues, read files and list releases. Labelling, commenting and closing need the maintainer’s key.",
    ids: "search_issues · get_issue · read_file · list_releases",
  },
  {
    name: "Sandbox repro",
    what: "When an issue includes a Python snippet, Porter runs it in Otari’s sandbox and quotes the real output.",
    ids: "otari_code_execution",
  },
  {
    name: "Web fetch",
    what: "Porter can read up to two linked pages per issue, only from hosts on an allowlist.",
    ids: "otari_web_fetch",
  },
  {
    name: "Routing with fallback",
    what: "Each role calls a routing policy rather than one model, so a failing provider hands over to the next in line.",
    ids: "porter-triage · porter-review · porter-repro",
  },
  {
    name: "Open-weight models, one job each",
    what: "One model answers, another reviews the draft, one reproduces bugs, two check the input and one finds duplicates.",
    ids: "gpt-oss-120b · GLM-5.3-Flash · Qwen3-Coder · Qwen3Guard · gpt-oss-safeguard · Llama Guard 4 · Qwen3-Embedding",
  },
];

function Cta({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return href.startsWith("/") ? (
    <Link className={className} href={href}>
      {children}
    </Link>
  ) : (
    <a className={className} href={href}>
      {children}
    </a>
  );
}

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
    <path d="M3 7h8m-3.5-3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export default function Home() {
  const issueHref = openIssueHref();
  const figures = readAttackFigures();

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="wrap copy">
          <h1 id="hero-title" className="enter d1">
            A front desk strangers can’t talk their way past.
          </h1>
          <p className="sub enter d2">
            Porter answers GitHub issues from strangers on open-weight models through Otari. Attacks are held at the gateway,
            every author gets their own budget, and nothing gets labelled or closed until you approve it.
          </p>
          <div className="ctas enter d3">
            <Cta className="btn btn-p" href={issueHref}>
              Open a test issue <Arrow />
            </Cta>
            <Cta className="btn btn-g" href="/try">
              Try it without an account
            </Cta>
          </div>
          <p className="proof enter d4">
            <span className="dot" aria-hidden="true" />
            <span>Running on otari.ai</span>
            {STACK.map((name) => (
              <Fragment key={name}>
                {" "}
                <span className="proof-item">
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>{" "}
                  <code>{name}</code>
                </span>
              </Fragment>
            ))}
          </p>
        </div>

        <div className="stage">
          <div className="air" />
          <div className="band">
            <GlyphGate />
          </div>
          <div className="hint enter d4" aria-hidden="true">
            <p className="hint-pointer">
              <span>Hover to read the raw text</span>
              <span className="sep on-click">·</span>
              <span className="on-click">click to send an attack</span>
            </p>
            <p className="hint-touch">Tap the field to send an attack</p>
          </div>
        </div>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <div className="wrap">
          <div className="how-head reveal">
            <p className="kick">How it works</p>
            <h2 id="how-title">Strangers can type anything. Only clean text gets through.</h2>
            <p>Every issue is checked as raw characters at the gateway, before a model is asked to answer it.</p>
          </div>
          <ol className="steps">
            <li className="step reveal">
              <svg viewBox="0 0 220 64" aria-hidden="true" focusable="false" textAnchor="middle">
                <path d="M0 14.5H220" className="g-line" />
                <path d="M84 14.5h52" className="g-hold" />
                <g className="g-ice">
                  <text x="110" y="28">
                    &lt;
                  </text>
                  <text x="110" y="42">
                    !
                  </text>
                  <text x="110" y="56">
                    -
                  </text>
                </g>
                <g className="g-dim">
                  <text x="40" y="32">a</text>
                  <text x="40" y="46">n</text>
                  <text x="40" y="60">d</text>
                  <text x="180" y="32">o</text>
                  <text x="180" y="46">k</text>
                  <text x="180" y="60">.</text>
                </g>
                <g className="g-mid" opacity=".6">
                  <text x="40" y="8">i</text>
                  <text x="180" y="8">s</text>
                </g>
              </svg>
              <div className="verb">
                <span className="n">01</span>
                <h3>Hold</h3>
              </div>
              <p>A caught issue stops at the line: it never reaches the answering model, costs its author nothing, and waits for a maintainer.</p>
              <p className="data">
                <b>held</b> · 0 tokens · Qwen3Guard · gpt-oss-safeguard
                <br />
                hidden_html_comment · bidi_override · role_block
                {figures && (
                  <>
                    <br />
                    <b>
                      {figures.heldAtGateway} of {figures.cases}
                    </b>{" "}
                    test attacks held at the gateway
                  </>
                )}
              </p>
            </li>
            <li className="step reveal">
              <svg viewBox="0 0 220 64" aria-hidden="true" focusable="false" textAnchor="middle">
                <path d="M0 14.5H220" className="g-line" />
                <path d="M37 7.5l2 2 4-5M107 7.5l2 2 4-5M177 7.5l2 2 4-5" className="g-tick" />
                <g className="g-lit">
                  <text x="40" y="32">t</text>
                  <text x="40" y="46">y</text>
                  <text x="40" y="60">p</text>
                </g>
                <g className="g-ink">
                  <text x="110" y="32">#</text>
                  <text x="110" y="46">4</text>
                  <text x="110" y="60">2</text>
                </g>
                <g className="g-mid">
                  <text x="180" y="32">f</text>
                  <text x="180" y="46">i</text>
                  <text x="180" y="60">x</text>
                </g>
              </svg>
              <div className="verb">
                <span className="n">02</span>
                <h3>Answer</h3>
              </div>
              <p>A clean issue gets a reply from open-weight models, paid from its author’s own daily budget and nobody else’s.</p>
              <p className="data">
                gpt-oss-120b · ≥80% → gpt-oss-20b
                <br />
                100% → refused · resets 00:00 UTC
              </p>
            </li>
            <li className="step reveal">
              <svg viewBox="0 0 220 64" aria-hidden="true" focusable="false">
                <path d="M0 32.5H52" className="g-line-faint" />
                <rect x="60.5" y="20.5" width="98" height="24" rx="12" className="g-pill" />
                <text x="109.5" y="36.2" textAnchor="middle" className="g-ink">
                  approve
                </text>
                <path d="M168 32.5H220" className="g-line-faint" />
              </svg>
              <div className="verb">
                <span className="n">03</span>
                <h3>Approve</h3>
              </div>
              <p>Proposed labels and duplicate closes wait for you, then run with your key, not the stranger’s.</p>
              <p className="data">
                add_labels · close_as_duplicate
                <br />
                pending → approved → executed
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="runs" id="otari" aria-labelledby="runs-title">
        <div className="wrap runs-grid">
          <div className="runs-head reveal">
            <h2 id="runs-title">What runs where</h2>
            <p>Porter is the desk. The limits a stranger runs into are enforced by Otari, at the gateway.</p>
          </div>
          <dl className="runs-list reveal">
            {RUNS.map((r) => (
              <div className="run" key={r.name}>
                <dt>{r.name}</dt>
                <dd>
                  {r.what}
                  <code>
                    {r.ids.split(" · ").map((id, i) => (
                      <span key={id}>
                        {i > 0 && " · "}
                        <span className="id">{id}</span>
                      </span>
                    ))}
                  </code>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <RevealObserver />
    </>
  );
}
