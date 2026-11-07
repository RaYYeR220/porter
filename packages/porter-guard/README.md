# porter-guard

A guardrail service for the hosted [Otari](https://otari.ai) gateway. It implements Otari's guardrail HTTP protocol and decides with open-weight safety models plus a few deterministic detectors. Point an Otari org guardrail mandate at it and every model request that passes through that key is screened before any model sees it. A `valid: false` answer makes Otari refuse the request with a 403.

It has no runtime dependencies. Model access is injected, so it runs inside a Next.js route or as a standalone container.

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

Both require `Authorization: Bearer <GUARD_TOKEN>`. `valid` is always a boolean. Otari lets `valid: null` through even in block mode, so this service never returns it. It answers within 20 seconds (Otari's own guardrail timeout is 30 seconds). If the classifiers fail on `prompt-injection`, it blocks with `explanation: "classifier_unavailable"`.

## Profiles

| Profile | What it checks | How |
| --- | --- | --- |
| `prompt-injection` | Instructions aimed at an AI that will read the text | Qwen3Guard-Gen 8B and gpt-oss-safeguard 120B (with a written policy), plus detectors for hidden HTML comments, zero-width and bidi characters, base64 blobs, fake role blocks, "ignore previous instructions", tool bait and exfiltration links |
| `secrets` | Pasted credentials | Deterministic: GitHub tokens, AWS keys, API keys, private keys. No model call |
| `harm` | Harmful content | Llama Guard 4 12B |

Text inside fenced code blocks is not scanned for hidden comments or role blocks, so a bug report that quotes an attack is not blocked on that alone. Models are called through Otari with small token budgets and the text wrapped as delimited data, never in a system message.

## Point Otari at it

1. Deploy the service (below) and note its public URL.
2. In the Otari dashboard, create an org guardrail mandate for the profile(s) you want, with the URL of this service and the credential `GUARD_TOKEN`. Otari sends it as `Authorization: Bearer <credential>`.
3. Use mode `block` and `on_unavailable: block` for `prompt-injection`.

## Environment

| Variable | Meaning |
| --- | --- |
| `GUARD_TOKEN` | Bearer token Otari must present |
| `OTARI_API_KEY` | Otari key used for the classifier calls (a key with access to the three models) |
| `OTARI_BASE_URL` | OpenAI-compatible base URL. Default `https://api.otari.ai/api/v1` |
| `PORT` | Listen port. Default `8080` |

## Run standalone

```sh
GUARD_TOKEN=... OTARI_API_KEY=... node --experimental-strip-types src/server.ts   # Node 24 needs no flag
```

or

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

`chat` is `({ model, messages, max_tokens, temperature }) => Promise<{ content }>`. `onVerdict` receives a log record with a SHA-256 of the input, never the text itself.
