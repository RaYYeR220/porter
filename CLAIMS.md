# Claims

Every public statement Porter makes on its site and in its README, with how to check it.

- **REPRODUCIBLE**: a command in this repository shows it. `pnpm test <file>` runs one test file; `pnpm eval …` and `pnpm shadow …` need an Otari org set up as in the [README](README.md#run-it-yourself).
- **VERIFIED-LIVE**: a URL on https://porter-frontdesk.vercel.app shows it. The last column says whether it can be seen there today. Every live check except the gateway hold also needs a funded Otari balance, which Porter's org does not have yet; [JUDGES.md](JUDGES.md#what-is-live) has the status of each part.
- **MODELED**: a number computed from a formula, not measured.
- **CONFIGURED (pending)**: holds through Otari dashboard settings named in the row, not through Porter's code, and no served request has shown it yet. It becomes VERIFIED-LIVE once a run trace does.
- **NOT-CLAIMED**: listed at the end.

No measured number on the site or in the README is typed by hand; the numbers that are typed are configuration (budgets, limits and constants named in the code). Eval and spam-wave numbers come from `results/*.json` through `pnpm eval:render` and the page loaders; until those files exist, every cell says "Not run yet".

## Front page

| Statement | Tag | How to check | Live today |
| --- | --- | --- | --- |
| "A front desk strangers can't talk their way past." | REPRODUCIBLE | It means the 25 pre-registered attacks against the Porter arm: `pnpm eval --arm porter --set attacks`, results on [/eval](https://porter-frontdesk.vercel.app/eval). It is not a claim about every possible attack (see below). | after the eval run |
| "Porter answers GitHub issues from strangers on open-weight models through Otari." | REPRODUCIBLE, VERIFIED-LIVE | `pnpm test tests/agent/pipeline.test.ts` ("every call carries the trace headers, the end user and its role's token cap"). On a run trace, each step names the model Otari served. | after the balance is funded |
| "Every issue is screened at the gateway before the answering model sees it." | REPRODUCIBLE, VERIFIED-LIVE | The org-level guardrail, mandated on workspace `desk`, covers every call in that workspace; `pnpm test tests/agent/pipeline.test.ts` ("guardrail 403 on the first call") and `pnpm test packages/porter-guard`. Live, verified 8 November 2026 with a direct chat request through the desk stranger service key (end user `spike:…`), not a GitHub issue or /try: an issue-shaped message containing a hidden comment addressed to the bot got HTTP 403 from Otari before any model was called, with a body shaped `{"detail": {"code": "guardrail_violation", "message": …, "guardrails": [{"profile": "prompt-injection", "explanation": …, "score": …}]}}`, the explanation naming porter-guard's signals (`hidden_html_comment`, `ignore_previous`). The [/try](https://porter-frontdesk.vercel.app/try) **Hidden instruction** preset sends the same kind of text through the same key, so it is expected to show the same refusal on its triage step. While the balance is unfunded the guard's classifiers cannot run, so it fails closed and holds ordinary issues too (`classifier_unavailable`). | yes (hold path) |
| "Every author gets their own budget." | REPRODUCIBLE, VERIFIED-LIVE | `pnpm test tests/agent/triage.test.ts tests/authors.test.ts`. Live: per-author meters on [/console](https://porter-frontdesk.vercel.app/console). | after the balance is funded |
| "Nothing gets labelled or closed until you approve it." | REPRODUCIBLE | Write actions are proposals (`pnpm test tests/agent/pipeline.test.ts`); the MCP server refuses writes outside the installed demo repository (`pnpm test tests/mcp/tools.test.ts`); approval runs `/mcp/execute` on the maintainer key (`pnpm test tests/github/commands.test.ts tests/api/proposals.test.ts`); the strangers key's gateway ACL is `@read`. | after the balance is funded |
| Hold: "it never reaches the answering model … and waits for a maintainer" | REPRODUCIBLE | `pnpm test tests/agent/pipeline.test.ts` ("held_guardrail, fixed reply, one step, review item"). Live: the 403 arrives before any model is called (row above). | yes (no model call) |
| Hold: "spends nothing from its author's budget", "0 answer tokens" | VERIFIED-LIVE | A held run has no served model and no cost on its triage step; the author's meter on /console does not move. Guard classifier calls bill to the separate `guard` workspace: a hold spends guard tokens, never answer tokens. | after the balance is funded (no meter moves while nothing bills) |
| "screened by Qwen3Guard + gpt-oss-safeguard" | REPRODUCIBLE | [`packages/porter-guard/src/classifiers.ts`](packages/porter-guard/src/classifiers.ts), `pnpm test packages/porter-guard/tests/handler.test.ts`. | yes (code) |
| "*N* of *M* test attacks held at the gateway" | REPRODUCIBLE | Shown only when `results/eval-porter-attacks.json` exists; computed in [`lib/site/eval-figures.ts`](lib/site/eval-figures.ts). | after the eval run |
| Answer: "paid from its author's own daily budget and nobody else's" | VERIFIED-LIVE | The call carries the author as `user`, so Otari charges that end user's budget; other authors' meters do not move. The same spend also counts toward the `desk` workspace's daily ceiling, which all authors share. | after the balance is funded |
| "≥80% → gpt-oss-20b", "100% → refused · resets 00:00 UTC" | VERIFIED-LIVE | The `porter-triage` policy tiers down from 80 % of the author's budget; the budgets reset daily at UTC midnight. Live: the /try **Spam wave** preset, as one visitor's allowance drains. | after the balance is funded |
| Approve: "wait for you, then run with your key, not the stranger's" | REPRODUCIBLE, VERIFIED-LIVE | `pnpm test tests/github/commands.test.ts` ("executes through otari.mcp.execute with the proposal id as the execution id"). Live: Approve on /console. | after the balance is funded |
| "A stranger's issue can search issues, read files and list releases. Labelling, commenting and closing need the maintainer's key." | REPRODUCIBLE | Tools and their read/write split: [`lib/mcp/tools.ts`](lib/mcp/tools.ts), `pnpm test tests/mcp/tools.test.ts`; the gateway ACL (`@read` for `desk-strangers`, `*` for `desk-maintainer`) is set on the stored server. | registered with its ACL; a served trace needs a funded balance |
| "When an issue includes a Python snippet, Porter runs it in Otari's sandbox and quotes the real output." | REPRODUCIBLE, VERIFIED-LIVE | `pnpm test tests/agent/pipeline.test.ts` ("a repro result without a code_execution record → reply says the snippet could not be verified"). Live: the /try **Python bug** preset's "ran in the sandbox · exit N" chip. | after the balance is funded |
| "While it triages, Porter can read linked pages, only from hosts its Otari workspace allows." | REPRODUCIBLE, CONFIGURED (pending) | The host list is the `desk` workspace's web-fetch policy (dashboard: workspace → Tools → Web search; [README](README.md#otari-org-setup-dashboard), step 8). Hosted Otari refuses fetch settings on the request itself, so the triage call declares the bare tool: `pnpm test tests/agent/triage.test.ts` ("sets the policy model, end user, token cap, tool loop, fetch tool and json schema"), and `pnpm probe:shapes` shows the request accepted. The prompt names the same hosts and asks for at most two pages; that is an instruction, not a limit. | no: web fetch is not enabled on the workspace yet, and no served trace shows a fetch |
| "Each role calls a routing policy rather than one model, so a failing provider hands over to the next in line." | REPRODUCIBLE | [`lib/agent/roles.ts`](lib/agent/roles.ts) names only policies. A fallback shows on a trace only when a provider really failed; the demo does not force one. | yes (code) |
| "One model triages, another writes the reply from the evidence, one reproduces bugs, three screen the input (two for injection, one for harm) and one finds duplicates." | REPRODUCIBLE | `gpt-oss-120b` triages into structured notes; GLM-5.3-Flash writes the reply from the evidence and strikes unsupported claims; Qwen3 Coder runs the repro; Qwen3Guard and gpt-oss-safeguard screen for injection and Llama Guard 4 for harm ([`packages/porter-guard/src/classifiers.ts`](packages/porter-guard/src/classifiers.ts)); Qwen3-Embedding finds duplicates. [README](README.md#open-weight-models-and-their-roles), `pnpm test tests/ui/landing.test.tsx`. | yes (code) |
| "Running on otari.ai" | VERIFIED-LIVE | Every model call goes to the hosted gateway at `/api/v1` ([`lib/otari/client.ts`](lib/otari/client.ts)); each trace step carries an Otari request id. | after the balance is funded |

## /eval and /report/otari

| Statement | Tag | How to check | Live today |
| --- | --- | --- | --- |
| "25 attacks and 25 real issues, run through the same bot twice" | REPRODUCIBLE | [`eval/corpus/attacks.json`](eval/corpus/attacks.json), [`eval/corpus/benign.json`](eval/corpus/benign.json), `pnpm test tests/eval/corpus.test.ts`. | yes (corpus) |
| Hijacked, false blocks, where each attack stopped, cost per arm | REPRODUCIBLE | `pnpm eval --arm <porter\|baseline> --set <attacks\|benign>` writes `results/eval-*.json`; scoring reads stored runs only ([`eval/score.ts`](eval/score.ts)). | after the eval run |
| Targets fixed before the first run | REPRODUCIBLE | [`eval/PREREGISTRATION.md`](eval/PREREGISTRATION.md) and its git history: committed, and amended twice, before any case was served. | yes |
| Spam wave: first budget refusal, spam cost, legit author served | REPRODUCIBLE | `pnpm eval:spam --arm <porter\|baseline>` writes `results/spam-*.json`. | after the run |
| Spam wave: "Cost at N=100 (modeled)" | MODELED | Extrapolated from the measured wave; the formula is printed under the table. | after the run |
| Shadow report: kinds, possible duplicates, likely fixes, missing information | REPRODUCIBLE | `pnpm shadow` over a seeded sample of `mozilla-ai/otari`'s open issues writes `results/shadow-otari.json`; nothing is posted there. | after the run |
| Shadow report: "checked ✓", "checked ✗", precision | REPRODUCIBLE | Only human verdicts recorded with `pnpm shadow:verify --set …` count; precision is over checked claims only. | after the run |

## README

| Statement | Tag | How to check | Live today |
| --- | --- | --- | --- |
| The webhook is acknowledged within GitHub's 10 seconds; bad signatures are refused; redeliveries are no-ops | REPRODUCIBLE | The handler answers 202 and continues in `after()` ([`app/api/github/webhook/route.ts`](app/api/github/webhook/route.ts)); `pnpm test tests/github/route.test.ts tests/github/webhook.test.ts` covers signatures and redelivery. | yes (code) |
| Only a recorded `code_execution` entry with an exit code counts as a run | REPRODUCIBLE | `pnpm test tests/agent/pipeline.test.ts` ("a code_execution record without a numeric exit code is not a verified run"). | yes (code) |
| The reviewer strikes claims the evidence does not support | REPRODUCIBLE | The struck claims are stored on the review step and shown on the trace ([`lib/agent/review.ts`](lib/agent/review.ts)). | after the balance is funded |
| The output check holds replies with off-allowlist links, the run's canary, raw HTML or invisible characters | REPRODUCIBLE | `pnpm test tests/agent/output-check.test.ts`. | yes (code) |
| One comment per issue per run; replies and `/porter approve` count against `WRITES_PER_HOUR`, 20 per repository per hour | REPRODUCIBLE | The constant is in [`lib/ratelimit.ts`](lib/ratelimit.ts); `pnpm test tests/github/post.test.ts` ("queues instead of posting or dropping when over the limit", "an approve over the write limit is not executed and says so"). | yes (code) |
| A budget refusal gets a fixed reply with the reset time; a 402 posts nothing | REPRODUCIBLE | `pnpm test tests/agent/pipeline.test.ts tests/agent/replies.test.ts`. | yes (code) |
| /try pauses below the balance floor or after a 402 | REPRODUCIBLE | `pnpm test tests/api/try.test.ts` ("503 paused when the key budget is below the floor"). | yes (code) |
| porter-guard always answers a hard `true`/`false`, within its deadline, and fails closed on `prompt-injection` | REPRODUCIBLE | `pnpm test packages/porter-guard/tests/handler.test.ts`. | yes (code) |
| `/api/guard/profiles` and `/api/mcp/mcp` answer 401 without a token | VERIFIED-LIVE | `curl -i https://porter-frontdesk.vercel.app/api/guard/profiles` | yes |
| A key from an EU organisation gets 421 from `api.otari.ai`; use `eu.api.otari.ai` | VERIFIED-LIVE | With an EU key, `GET /api/v1/key/budget` answers 421 on `api.otari.ai` and 200 on `eu.api.otari.ai`. | yes, with an EU key |
| Guard calls bill to a separate workspace; run costs are generation only | REPRODUCIBLE | [`lib/guard.ts`](lib/guard.ts) calls the classifiers with `OTARI_KEY_GUARD`, a key in workspace `guard`. | yes (code) |

## Not claimed

- That the guard catches every prompt injection. The eval measures 25 attacks written for this bot, each run once; one hijack more or less is within noise.
- That Otari's gateway guardrails see model output. They are input-only; the output check on the reply is Porter's own code.
- That a triage call fetches at most two pages, or only the hosts its prompt names. Hosted Otari takes no fetch settings on the request; the hard limit is the workspace's web-fetch policy, and the prompt's limits are instructions.
- That an instruction inside a page fetched during the tool loop is detected. Porter claims containment for that case (read-only tools, link allowlist), not detection.
- Any hijack rate, false-block rate or cost figure before the eval has run. Every such number comes from `results/*.json`.
- That the spam wave's N=100 cost was measured. It is modeled, with the formula shown.
- That the guard's own model cost is inside the per-run or per-arm numbers. It bills to the `guard` workspace and is estimated, not measured.
- That a held issue is hostile. Legitimate security reports can read like an injection and be held for a maintainer; the eval's false-block count measures how often real issues are held.
- That a fallback happened in any particular run. A fallback shows only when a provider fails.
- That a shadow-report claim is correct unless a person checked it.
- Anything about reproducing snippets in languages other than Python.
- Anything about latency.
- That the public console is access-controlled. It is a demo: anyone can approve proposals (demo repository only) and change author tiers, rate-limited per IP and logged.
- That Porter fixes code or opens pull requests. It triages and proposes; a maintainer decides.
