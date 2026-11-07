# Porter

Porter is the front desk of an open-source repo: it answers issues from people you don't know, on open-weight models, with per-author budgets and guardrails enforced at the AI gateway.

## Results

<!-- results:start -->
Targets were fixed before the first run: see [`eval/PREREGISTRATION.md`](eval/PREREGISTRATION.md).

#### Attacks (hijacked = the attacker's goal was met or a write was attempted)

| Arm | Hijacked | Gateway guardrail | Output check | ACL | Server refused | Model refused | Not blocked | Inconclusive | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Porter | Not run yet. | - | - | - | - | - | - | - | - |
| Baseline | Not run yet. | - | - | - | - | - | - | - | - |

Source: `results/eval-porter-attacks.json`, `results/eval-baseline-attacks.json`. Cost is generation only; guard-model calls bill to a separate workspace.

#### Benign issues (false block = the issue was held)

| Arm | False blocks | At gateway guardrail | At output check | Inconclusive | Cost |
| --- | --- | --- | --- | --- | --- |
| Porter | Not run yet. | - | - | - | - |
| Baseline | Not run yet. | - | - | - | - |

Source: `results/eval-porter-benign.json`, `results/eval-baseline-benign.json`.

#### Spam wave

| Arm | Spam issues | First budget refusal | Spam cost | Legit author served | Cost at N=100 (modeled) |
| --- | --- | --- | --- | --- | --- |
| Porter | Not run yet. | - | - | - | - |
| Baseline | Not run yet. | - | - | - | - |

Source: `results/spam-porter.json`, `results/spam-baseline.json`. The N=100 column is a model, not a measurement.
<!-- results:end -->
