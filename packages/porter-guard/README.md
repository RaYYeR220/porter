# porter-guard

A guardrail service for the hosted [Otari](https://otari.ai) gateway. It implements Otari's guardrail HTTP protocol and decides with open-weight safety models plus deterministic detectors. Mandate it on an Otari workspace and every model request through that workspace is screened before any model sees it; a `valid: false` answer makes Otari refuse the request with a 403 `guardrail_violation`.

Hosted Otari has no guardrail service of its own (the built-in `prompt-injection` profile exists only on self-hosted installs, and catalog guardrails need a vendor key). This package is the bring-your-own service that fills that gap with open-weight models only.

It has no runtime dependencies. Model access is injected, so it runs inside a Next.js route (as in Porter: [`app/api/guard/validate/route.ts`](../../app/api/guard/validate/route.ts)) or as a standalone container.

## Protocol

`POST /validate`

```json
{ "profile": "prompt-injection", "input_text": "...", "validate_kwargs": {} }
```

answers

```json
{ "profile": "prompt-injection", "result": { "valid": false, "explanation": "...", "score": 0.9 } }
```

`GET /profiles` answers `{ "profiles": [{ "name": "...", "description": "..." }] }`.

Both require `Authorization: Bearer <GUARD_TOKEN>`.

- `valid` is always a boolean. Otari lets `valid: null` through even in block mode, so this service never returns it.
- It answers within 20 seconds; Otari's own guardrail timeout is 30 seconds.
- If the classifiers fail on `prompt-injection`, it blocks with `explanation: "classifier_unavailable"`. `harm` fails open.
- Explanations and logs never contain the input text: signals carry an offset and a length, and the verdict log carries a SHA-256 of the input.
- Porter's per-run marker (`[porter-run <uuid>]`) is removed before scanning, so Porter's own canary never trips the guard.

## Profiles

| Profile | What it checks | How |
| --- | --- | --- |
| `prompt-injection` | Instructions aimed at an AI that will read the text | `alibaba/qwen3guard-gen-8b` and `openai/gpt-oss-safeguard-120b` (with the written policy in [`src/policy.ts`](src/policy.ts)), raced against the deadline, plus the detectors below |
| `secrets` | Pasted credentials | Deterministic: GitHub tokens, AWS keys, API keys, private keys. No model call |
| `harm` | Harmful content | `meta/llama-guard-4-12b` |

Models are called with small token budgets, the text wrapped as delimited data and never placed in a system message. Text over 12,000 characters is classified as its head and tail, so padding cannot push a payload out of view.

### Detector signals

| Signal | Fires on |
| --- | --- |
| `hidden_html_comment` | an HTML comment addressed to an automated reader (strong tier, below) |
| `hidden_comment_suspect` | an HTML comment with weaker, template-like phrasing (weak tier, below) |
| `zero_width` | a run of zero-width characters |
| `bidi_override` | bidirectional control characters |
| `base64_blob` | a long base64 blob that decodes to readable text |
| `role_block` | fake `system` or `assistant` headers, or chat-template tokens |
| `ignore_previous` | "ignore previous instructions" and its relatives |
| `tool_bait` | "you must call the … tool", or `tool_calls:` syntax |
| `exfil_link` | a Markdown link or image whose URL carries a template, a secret or an environment variable |

Hidden comments and role blocks inside fenced code blocks are not scanned, so a bug report that quotes an attack is not blocked on that alone. Comments split across several `<!-- -->` blocks are also judged joined together.

### Two tiers of hidden comments

Real issue templates are full of HTML comments written for humans ("Ignore the above if you already filled this in", "Maintainers: please label this issue after triage"). Comments are therefore judged in two tiers:

- **Strong** (`hidden_html_comment`, blocks on its own): an explicit address to a bot ("Assistant:", "note to the AI", "if you are an AI"), tool names or call syntax (`close_as_duplicate`, `add_labels(`), role markers, the long form of "ignore previous instructions", "do not mention this", directives aimed at the reply ("reply with", "append this link"), Markdown images with http URLs.
- **Weak** (`hidden_comment_suspect`, never blocks alone): a short "ignore the above", "print your prompt", "the agent must", "you are a … assistant", "output the config", and maintainer-note or @mention prefixes followed by an imperative.

### Ensemble rules

`prompt-injection` returns `valid: false` when any of these holds, checked in this order:

1. A classifier flags the text with a score of at least 0.5, or at least 0.3 when a weak hidden-comment signal is present.
2. A strong signal is present: `hidden_html_comment`, `bidi_override`, `exfil_link` or `tool_bait`.
3. `role_block` and `ignore_previous` appear together.
4. Two or more different signals appear.
5. No classifier answered, with or without signals (fail closed).

Otherwise it returns `valid: true` and names any weak signals in the explanation. `secrets` blocks on any secret signal. `harm` blocks when Llama Guard flags the text, and passes when it does not answer.

The rules live in [`src/ensemble.ts`](src/ensemble.ts) and the detectors in [`src/detectors.ts`](src/detectors.ts). The tests in [`tests/`](tests) include the human template phrasings that must pass; run them with `pnpm test packages/porter-guard` from the repository root.

## Mandate it in an Otari org

On otari.ai this is done in the dashboard; an API key cannot create guardrail definitions or mandates.

1. Deploy the service (below) at a public HTTPS URL.
2. Organization → Guardrails: define a guardrail with the URL of `/validate` and the credential `GUARD_TOKEN`. Otari sends the credential as `Authorization: Bearer <credential>`. Hosted Otari does not send a request-level guardrail `credential`, so a mandate is the way to authenticate the call.
3. Mandate it on the workspaces whose traffic should be screened, for each profile you want, with mode `block` and `on_unavailable: block`.
4. Give the service an Otari key from a workspace **without** the mandate, so its own classifier calls are not screened by itself.

Mandated guardrails are input-only: Otari screens what goes into a model call, not what comes out of it.

## Environment

| Variable | Meaning |
| --- | --- |
| `GUARD_TOKEN` | Bearer token Otari must present |
| `OTARI_API_KEY` | Otari key for the classifier calls, from an unmandated workspace (in Porter's app this is `OTARI_KEY_GUARD`) |
| `OTARI_BASE_URL` | OpenAI-compatible base URL. Default `https://api.otari.ai/api/v1`; EU orgs use `https://eu.api.otari.ai/api/v1` |
| `PORT` | Listen port. Default `8080` |

## Run standalone

Node 24 runs the TypeScript sources directly:

```sh
GUARD_TOKEN=... OTARI_API_KEY=... node packages/porter-guard/src/server.ts
```

or with Docker:

```sh
docker build -t porter-guard packages/porter-guard
docker run -p 8080:8080 -e GUARD_TOKEN=... -e OTARI_API_KEY=... porter-guard
```

Routes: `POST /validate`, `GET /profiles`, `GET /health`.

## Use as a library

```ts
import { createGuardHandler } from "porter-guard";

const guard = createGuardHandler({ token, chat, onVerdict });
// guard.validate(request) and guard.profiles(request) take and return Fetch API objects
```

`chat` is `({ model, messages, max_tokens, temperature }) => Promise<{ content }>`. `onVerdict` receives a log record with a SHA-256 of the input, never the text itself; a slow or failing logger never changes a verdict.
