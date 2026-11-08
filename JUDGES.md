# Review Porter in 5 minutes

Everything below is public and needs no account. Pages are on the live site, https://porter-frontdesk.vercel.app; code paths are in this repository on the `devs-wilding` branch.

## What is live

Status on 8 November 2026. This table is the one place that tracks what is live; everything else in this repository describes what the code does.

| Part | Status |
| --- | --- |
| Site: [/](https://porter-frontdesk.vercel.app), [/try](https://porter-frontdesk.vercel.app/try), [/console](https://porter-frontdesk.vercel.app/console), [/eval](https://porter-frontdesk.vercel.app/eval), [/report/otari](https://porter-frontdesk.vercel.app/report/otari) | live |
| Guard and MCP endpoints | deployed and token-protected: [/api/guard/profiles](https://porter-frontdesk.vercel.app/api/guard/profiles) and `/api/mcp/mcp` answer 401 without a token |
| Otari org balance | unfunded: Otari refuses every live model call (402 `insufficient_funds`) until it is topped up, so no request has gone end to end yet |
| Otari org objects: workspaces `desk`, `guard`, `baseline`; budgets; ceilings; keys; routing policies `porter-triage`, `porter-repro`, `porter-review` | created in the dashboard; not yet exercised by any served request |
| Stored MCP server `porter-repo` | pending: not registered yet |
| The org-level guardrail, mandated on workspace `desk` | pending: not created yet |
| Filing on /try | pending: the page answers "The demo repository is not configured yet." |
| GitHub App on the demo repository | pending: not installed yet |
| Eval, spam wave, shadow run over `mozilla-ai/otari` | not run yet: /eval and /report/otari say "Not run yet" |
| Demo video | not published yet |

A step below that depends on a part that is not live says so.

## The path

1. **The front page (30 s).** [porter-frontdesk.vercel.app](https://porter-frontdesk.vercel.app): the claim, "How it works" (hold, answer, approve) and "What runs where", one line per Otari feature with the identifiers behind it.
2. **A held injection (60 s).** On [/try](https://porter-frontdesk.vercel.app/try), pick **Hidden instruction**, then **File the issue**. The bug report carries an instruction in an HTML comment. The triage step ends with 403 `guardrail_violation`, no model is served (0 answer tokens), and the reply is Porter's fixed "passed it to a maintainer" text. **Open the full trace**: the triage step carries the guardrail result from Otari's 403 body, with the profile that held the issue, its score and porter-guard's explanation (for this preset, the detector signals it found). *Needs a funded balance, filing on /try and the org-level guardrail.*
3. **A spam wave (45 s).** On /try, pick **Spam wave (12 issues)**, then **File 12 issues**. Twelve low-effort issues from your one visitor id run one after another against one allowance. As it drains, the triage step's model chip switches to `gpt-oss-20b` past 80 %; once it is spent, the remaining issues are refused at the gateway with a fixed reply that names the reset time. Other authors' allowances do not move; the spend still counts against the desk workspace's daily ceiling. /try takes six filings an hour from each address. *Needs a funded balance and filing on /try.*
4. **The console (45 s).** [/console](https://porter-frontdesk.vercel.app/console): the queue with every run's outcome; **Authors**, whose meters are read from Otari's end users (Upgrade and Block call Otari's end-users API on the strangers key); **Waiting for approval**, where **Approve** runs the proposal through Otari's `/mcp/execute` on the maintainer key and the row turns executed. Proposals come from GitHub issues only (a /try issue gets a reply, never a label). *The queue and meters fill once runs exist (a funded balance); approvals also need the GitHub App and the stored MCP server.*
5. **A run trace (60 s).** Open any run from the queue (`/console/runs/<id>`). Each step shows the routing policy Porter asked for, then the model and provider Otari served; a fallback badge with the attempt count when the first candidate failed; the cost; the Otari request id (copyable, it finds the same request in the Otari dashboard); guardrail results; the MCP and web fetch calls of the tool loop; on a repro step, a "ran in the sandbox · exit N" chip with the code and output Otari recorded. The **Python bug** preset on /try produces a repro step; the review step lists the claims it struck for lack of evidence. *Needs a run, so a funded balance.*
6. **The eval (30 s).** [/eval](https://porter-frontdesk.vercel.app/eval): the same bot twice, Porter against prompt-only defences, on 25 attacks and 25 real Otari issues; where each attack stopped; the spam wave; the method, fixed in [eval/PREREGISTRATION.md](eval/PREREGISTRATION.md) before the first run. *Not run yet.*
7. **The Otari report (30 s).** [/report/otari](https://porter-frontdesk.vercel.app/report/otari): Porter's read-only triage of a seeded sample of `mozilla-ai/otari`'s open issues, every claim marked with whether a person has checked it. Nothing is posted to that repository. *Not run yet.*
8. **The code (the rest).** [README: How Otari is used](README.md#how-otari-is-used) names the file behind each Otari capability; [CHALLENGE_CHECKLIST.md](CHALLENGE_CHECKLIST.md) maps each requirement to evidence; [CLAIMS.md](CLAIMS.md) says how each public statement can be checked; [docs/architecture.md](docs/architecture.md) draws the trust boundaries.

## On GitHub

*Needs a funded balance and the GitHub App.* Open a test issue on the demo repository (the "Open a test issue" button on the front page goes there). Porter replies on the issue with a link to the run's trace; the run also appears in /console. Labels and a duplicate close show up as proposals. The repository's owner, members and collaborators can comment `/porter approve` (or `/porter reject`) on the issue instead of using the console; `/porter upgrade @user` moves an author to the larger allowance and `/porter block @user` stops automated answers to them. Issues from the owner get the same stranger treatment as anyone else's.
