# The Identical Twins Test

Send the same prompt to two models. Render each answer as a cloud of particles — one
particle per sampled point. Then try to morph Model A's cloud into Model B's.

**If the two answers are byte-identical, the particles do not move at all.** The cloud
locks, desaturates, and a large `IDENTICAL` badge stamps over it with a counter reading
`0 particles moved`. That frozen frame is the finding: these two models are frequently
the same model wearing a different name.

When the answers genuinely differ, the cloud explodes outward and reforms into the new
answer, with a `DIVERGED` badge and both sha256 digests side by side.

The point is to show, with visual proof, how an older model relates to a newer one —
where they are the same, and exactly where they diverge.

<img width="1624" height="1001" alt="Screenshot at Sep 15 18-55-05" src="https://github.com/user-attachments/assets/dc8d460a-108c-41cf-8b06-3dba837ae3ea" />
<img width="1624" height="1000" alt="Screenshot at Sep 15 18-55-29" src="https://github.com/user-attachments/assets/33fed07b-2c92-421b-9d95-d0e3c246fc4f" />

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [The request lifecycle](#the-request-lifecycle)
- [How the verdict is decided](#how-the-verdict-is-decided)
- [Test connection](#test-connection)
- [The particle system](#the-particle-system)
- [Text → particles](#text--particles)
- [Configuration](#configuration)
- [Presets](#presets)
- [Project structure](#project-structure)
- [HTTP API](#http-api)
- [Verification](#verification)
- [Fork and contribute](#fork-and-contribute)
- [Feature ideas](#feature-ideas)
- [Non-goals](#non-goals)
- [Credits](#credits)

---

## Why this exists

Model providers ship "new" versions constantly. The interesting question is not whether
the new one is better — it is **how much of it is actually new**.

Benchmarks answer that with a number, and a number is easy to argue with. This answers it
with a picture, and a picture is much harder to argue with: if two models return the same
bytes, the particle cloud does not move, and you are looking at the same model twice.

The design goal throughout was to make the *absence* of motion the loudest thing on
screen. Most visualisations are built to show activity; this one is built to make a
non-event feel like a verdict.

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, click **Settings**, paste your API key, and press
**Test connection** to confirm it works before running a comparison.

This app talks to a real model provider. There is no bundled stand-in and no offline
mode: without a working API key, nothing runs. That is deliberate — the whole point is
to compare what two real models actually return.

The API key is never hardcoded and never bundled. It is stored in your browser's
`localStorage` and sent only to the local server on port 3001, which forwards it to the
provider you configured.

| Command | What it does |
| --- | --- |
| `npm run dev` | API server on `:3001` and Vite on `:5173` with a dev proxy |
| `npm run dev:server` | Just the API server, with `tsx watch` |
| `npm run dev:web` | Just the frontend |
| `npm run build` | Typecheck, then build the frontend to `dist/` |
| `npm run typecheck` | Typecheck the app and the server |
| `npm start` | Run the API server without watch mode |

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Build | **Vite 8** | Instant HMR, and a dev proxy so the browser never sees the API port |
| UI | **React 19** + **TypeScript 5.9** | A small state machine; no router, no state library |
| 3D | **three.js 0.186** | Raw `THREE.Points` + a custom `ShaderMaterial` |
| Server | **Express 5** on **Node 20+** | Four endpoints, no framework needed |
| Runtime TS | **tsx** | Runs the server's `.ts` directly, no build step in dev |
| Dev runner | **concurrently** | One command starts both processes |

Deliberately absent: no component library, no CSS framework, no state manager, no
OpenAI SDK, no database, no auth. The whole app is roughly 2,400 lines across 20 files.

**No SDK is used on purpose.** The provider call is a plain `fetch` to
`/chat/completions`, which is what makes the app work against *any* OpenAI-compatible
endpoint — particle.ai, OpenAI, Together, Groq, a local llama.cpp server — by changing
one text field.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser — http://localhost:5173                                         │
│                                                                          │
│  ┌────────────────────────┐   ┌───────────────────────────────────────┐  │
│  │  React shell           │   │  WebGL stage                          │  │
│  │  App.tsx               │   │  particles.ts                         │  │
│  │   • phase state machine│   │   • 220,000-particle pool             │  │
│  │   • run history        │   │   • ShaderMaterial + morph            │  │
│  │   • JSON export        │   │   • lock() / morphTo()                │  │
│  └───────────┬────────────┘   └───────────────▲───────────────────────┘  │
│              │                                │ SampleResult             │
│              │                    ┌───────────┴───────────┐              │
│              │                    │  sampler.ts           │              │
│              │                    │  text → canvas → pts  │              │
│              │                    └───────────────────────┘              │
│              │                                                           │
│              │  fetch('/api/compare')      ← Vite dev proxy              │
└──────────────┼───────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────────┐
│  Node server — http://localhost:3001                                     │
│                                                                          │
│  index.ts            POST /api/compare   POST /api/test-connection       │
│                      POST /api/digest    GET  /api/health                │
│                                                                          │
│  model-client.ts     callModel()   → retry-on-empty, usage extraction    │
│                      testModel()   → one tiny probe per model            │
│                                                                          │
│  hash.ts             sha256(), newRunId(), newNonce()                    │
└──────────────┬───────────────────────────────────────────────────────────┘
               │  fetch POST {baseUrl}/chat/completions
               │  Authorization: Bearer <key from the browser>
               ▼
     ┌──────────────────────────────────────────────┐
     │  Any OpenAI-compatible provider              │
     │  default: https://api.particle.ai/v1         │
     └──────────────────────────────────────────────┘
```

The server exists for exactly three reasons, and it is worth being explicit about them
because a reviewer will ask why this is not a pure client-side app:

1. **The verdict is computed server-side.** `hashEqual` is decided by the server from the
   response bytes, so the client cannot accidentally (or conveniently) misreport it.
2. **The API key is never bundled.** It lives in `localStorage`, goes to `localhost:3001`,
   and is forwarded from there.
3. **CORS.** Most providers do not send permissive CORS headers, so a browser-only app
   would fail on the first request.

---

## The request lifecycle

```
 user clicks Run
        │
        ▼
 ┌─────────────┐
 │  calling    │  POST /api/compare { prompt, settings }
 └──────┬──────┘
        │        server: Promise.all([callModel('A'), callModel('B')])
        │        both get the SAME prompt + a fresh nonce
        ▼
 ┌─────────────┐
 │ laying-out  │  sampleTextToParticles(a.content) → layout A
 └──────┬──────┘
        │
        ├──── hashEqual === true ──────────────────────────┐
        │                                                  │
        │                                       ┌──────────▼──────────┐
        │                                       │  identical          │
        │                                       │  scene.lock()       │
        │                                       │  uFreeze = 1        │
        │                                       │  orbitSpeed = 0     │
        │                                       │  moved = 0          │
        │                                       └─────────────────────┘
        │                                          the frozen frame
        ▼
 ┌─────────────┐
 │  morphing   │  sampleTextToParticles(b.content) → layout B
 └──────┬──────┘  scene.morphTo(sampleB, { durationMs, burstRadius })
        │         every particle eases A → B with a radial burst
        ▼
      settled, with a real "particles moved" count
```

---

## How the verdict is decided

`POST /api/compare` calls both models concurrently with the same message and returns, for
each: `content`, `latencyMs`, `promptTokens`, `completionTokens`, `reasoningTokens`, and
`sha256(content)`.

The server then compares the two digests itself:

```ts
// server/index.ts
const [a, b] = await Promise.all([
  callModel('A', { ...shared, model: modelA }),
  callModel('B', { ...shared, model: modelB }),
]);

// The verdict is a byte comparison, not a similarity score.
const hashEqual = a.sha256 === b.sha256;
```

The client never guesses. `identical` is computed from the real response bytes,
server-side, and the UI reports `sha256 equal: true/false` alongside it.

### The cache problem, and the nonce

A naive version of this app has a fatal flaw: if the provider caches responses, sending
the same prompt twice can return the same bytes twice **even when the two models would
have answered differently**. That manufactures an `IDENTICAL` verdict out of nothing —
the single worst bug this app could have, because the fake result is exactly the result
the app is designed to find.

Every call therefore appends a fresh random nonce:

```ts
// server/hash.ts
export function newNonce(): string {
  return randomBytes(4).toString('hex');
}

// server/index.ts — the nonce is part of the user message
const userPrompt = `${prompt}\n\n[nonce ${nonce}]`;
```

The nonce that was sent is shown in the UI and included in the JSON export, so any run
can be reproduced or audited. Two calls can never share a cache key.

### Model aliasing, and why the served id matters

Providers are free to route an old model name to a new model. Ask for
`deepseek-v4-flash-0731` and the response may come back reporting
`model: "deepseek-v4.1-flash"` — the provider telling you it served something other than
what you named.

This matters enormously here. If both slots resolve to the same served id, the comparison
is **one model against itself**, and an `IDENTICAL` verdict is guaranteed no matter what
you ask. Reporting that as a discovery would be the worst kind of false positive: the app
would be loudly confirming the exact thing it exists to detect, on the basis of routing
rather than model behaviour.

So the served id is tracked as a first-class signal, separate from the requested name:

```ts
// server/model-client.ts — the response's own `model` field, not what we asked for
servedModel: outcome.model,
aliased: outcome.model !== req.model,
```

```ts
// server/index.ts
const sameModelId = a.servedModel === b.servedModel;
const anyAliased = a.aliased || b.aliased;
```

When both slots collide, the app says so in two places:

- **Test connection** warns before you run anything: *"Both names resolve to the same
  model. A comparison would be that model against itself, so it would report IDENTICAL no
  matter what you ask — that result would be routing, not a finding."*
- **A run** that collides gets a `Same model served twice` banner above the result, naming
  which slot was redirected and to where.

Individual aliases are surfaced too, even when only one slot is affected: the model column
shows the served id with an `asked for <name>` note beneath it, and the test panel lists
both names explicitly.

A provider that echoes back exactly what you asked for produces no warning — verified
against both a well-behaved endpoint and an aliasing one.

### Reasoning content is never transported

Reasoning models can return a `reasoning_content` field alongside `content`. That is
chain-of-thought, and it has no business in a log, an HTTP response, or the DOM.

The defence is structural rather than a filter: **the field does not exist in any type in
the codebase**, and the one function that reads a completion never looks at it.

```ts
// server/model-client.ts
interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
      // reasoning_content is intentionally NOT read. See extractContent().
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}
```

Only the token *count* crosses the wire, taken from
`usage.completion_tokens_details.reasoning_tokens`. There is nothing to leak, because
nothing ever reads it.

### Retrying an empty answer

A reasoning model can spend its entire token budget thinking and emit no answer at all.
That is not a real comparison, so an empty `content` triggers exactly one retry with a
doubled budget:

```ts
// server/model-client.ts
attempts += 1;
outcome = await callOnce(req, req.maxTokens);

if (outcome.content.length === 0) {
  attempts += 1;
  outcome = await callOnce(req, req.maxTokens * 2);
}
```

The result reports `retried: true` and `attempts: 2`, so a silent retry can never be
mistaken for a fast first try.

---

## Test connection

The settings panel has a **Test connection** button. It sends one tiny request to each
model (a short prompt, 16 max tokens, so it costs almost nothing) and reports per model:

- whether it answered, and how long it took
- the model id the provider actually served, if it differs from what you asked for
- a short sample of the reply, so you can see it really answered
- the reasoning token count

Failures are classified so the message names the fix, rather than just relaying a status
code:

```ts
// server/model-client.ts
function describeHttpFailure(status: number, body: string, model: string): string {
  const lower = body.toLowerCase();

  if (status === 401 || status === 403) {
    return 'The API key was rejected. Check that the key is complete and belongs to this base URL.';
  }
  if (status === 404) {
    if (lower.includes('model')) {
      return `The provider does not recognise the model "${model}". Check the model name.`;
    }
    return 'The endpoint was not found. Check the base URL — it should end in /v1 for most providers.';
  }
  if (status === 429) {
    return 'The provider is rate limiting this key. Wait a moment and test again.';
  }
  // …
}
```

| What happened | What it tells you |
| --- | --- |
| HTTP 401 / 403 | The API key was rejected — check it is complete and belongs to this base URL |
| HTTP 404 with "model" | The provider does not recognise that model name |
| HTTP 404 without it | The endpoint was not found — the base URL usually needs to end in `/v1` |
| HTTP 429 | The provider is rate limiting this key |
| No response in 30s | The base URL may be wrong or unreachable |

A bad key and a bad model name are different problems with different fixes, so conflating
them would waste the user's time.

Two details that matter:

- **The result clears the moment you edit any connection setting.** A stale "OK" can
  never describe a config you have since changed.
- **Probes run concurrently**, so testing takes as long as the slower model, not both.

---

## The particle system

A fixed pool of **220,000 particles** in a single `THREE.Points` with a custom
`ShaderMaterial`. The pool is allocated once and never resized; a larger answer simply
activates more of it.

### Why a fixed pool

Reallocating geometry per run would mean a GPU buffer upload on every comparison, and
garbage-collection hitches during the morph — the exact moment the animation has to be
smooth. A fixed pool means the only per-run work is writing into two `Float32Array`s.

Unused particles are not hidden with a draw-range trick. They are pushed 90 world units
away from the origin, out of frame, which keeps the shader branch-free:

```glsl
// Particles that do not exist in the incoming layout are pushed out of frame
// rather than left sitting on top of the new text.
float inactive = 1.0 - aActive;
base += normalize(base + vec3(0.001)) * inactive * 90.0;
```

### The morph

Every particle interpolates from its A position to its B position, with a radial burst
that peaks at the midpoint:

```glsl
vec3 base = mix(position, aTarget, uProgress);

// Burst impulse: radial kick, peaked at the midpoint of the morph.
vec3 dir = normalize(base + vec3(0.001));
float wobble = hash(vec3(aSeed * 91.7, aSeed * 13.3, uTime * 0.0));
float impulse = uBurst * uBurstRadius * (0.45 + 0.55 * wobble);
vec3 displaced = base + dir * impulse;
```

The CPU side drives the two envelopes — `easeInOutCubic` for position, `sin²` for the
burst:

```ts
// src/lib/particles.ts
const t = Math.min((now - this.morphStart) / this.morphDuration, 1);

// easeInOutCubic: slow out of A, fast through the middle, settle into B.
const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
this.material.uniforms.uProgress.value = eased;

// Burst envelope peaks at the midpoint of the morph.
const burst = Math.sin(Math.PI * t) ** 2;
this.material.uniforms.uBurst.value = burst;
```

The `wobble` term is what stops the burst looking like a perfect sphere expanding. Each
particle gets a deterministic per-seed multiplier between 0.45 and 1.0, so the cloud
frays instead of inflating.

### Making "nothing moves" literally true

This is the heart of the app, and it took two attempts to get right.

The first version froze the particles but left the camera orbiting. Measured drift of the
locked cloud: **0.77 px over 2.5 seconds**. Small, but fatal — a viewer sees motion and
concludes something happened, which destroys the entire claim.

So `lock()` stops the camera too:

```ts
lock(): void {
  this.morphing = false;
  this.phase = 'identical';
  this.material.uniforms.uFreeze.value = 1;
  this.material.uniforms.uSaturation.value = 0.55;
  this.material.uniforms.uBurst.value = 0;
  this.material.uniforms.uProgress.value = 0;
  this.targetPositions.set(this.basePositions);
  // Stop the camera too. "The particles do not move" has to be literally true,
  // so nothing in the frame is allowed to drift — including the viewpoint.
  this.orbitSpeed = 0;
  this.movedCount = 0;
  this.peakDisplacement = 0;
}
```

Note the `uFreeze` uniform in the vertex shader. A subtle breathing motion keeps a frozen
cloud from looking like a dead render — but it must not change any particle's *position*:

```glsl
// A little breathing motion so a frozen cloud still reads as alive, but the
// particles' *positions* never change when frozen.
float breathe = sin(uTime * 0.9 + aSeed * 6.2831) * 0.06 * (1.0 - uFreeze);
displaced += dir * breathe;
```

Drift after the fix: **0.064 px over 2.5 seconds** — under a tenth of a pixel, i.e. no
measurable motion at all.

### The moved counter is a measurement

`0 particles moved` is the headline number, so it cannot be a hardcoded zero. It is
computed by comparing every particle's destination against its origin:

```ts
for (let i = 0; i < POOL_SIZE; i += 1) {
  const dx = /* … */;
  if (dx * dx + dy * dy + dz * dz > 0.0004) moved += 1;
}
this.movedCount = moved;
```

The epsilon (`0.0004`, i.e. 0.02 world units) absorbs float noise from the normalisation
pass. If the two layouts are genuinely identical, every particle lands exactly where it
started and the count is genuinely zero.

---

## Text → particles

`src/lib/sampler.ts` turns an answer into particle positions:

1. Draw the text into an offscreen 1400×760 2D canvas, wrapped and centred.
2. Read the pixels back and sample on a 4px grid; every point where red > 110 becomes one
   particle target.
3. Normalise into a centred world space of height 24 units, with ±0.8 of z-jitter so the
   cloud has depth.

### Two bugs this caught

The first version used a fixed font size, and it produced two failure modes that were
invisible in code review and obvious the moment the clouds were measured:

| Answer | Particles (before) | Particles (after) |
| --- | --- | --- |
| `"Paris"` | **48** — an empty frame | 4,044 |
| A tall column of 20 digits | **145** — a faint streak | 2,206 |

Both are fixed by fitting the text to the frame instead of assuming a size:

```ts
// Largest font that fits, tried from biggest to smallest.
const FONT_CANDIDATES = [150, 120, 96, 76, 60, 48, 38, 30, 24, 19, 15, 12];

// Then: if the first pass came back thin, resample on a finer grid.
const MIN_PARTICLES = 2_500;
const finerStep = Math.max(1, Math.floor(step * Math.sqrt(count / MIN_PARTICLES)));
```

Every preset now lands between roughly 2,200 and 7,400 particles, so the cloud always
fills the view.

One more subtlety: the text block is centred **as a whole**, not line by line. Per-line
centring would destroy the internal alignment that ASCII art depends on — a cat drawn in
ASCII would come out with its ears in the wrong place.

---

## Configuration

Everything lives in the Settings panel and persists to `localStorage`.

| Setting | Default |
| --- | --- |
| Base URL | `https://api.particle.ai/v1` |
| API key | *(empty — you paste it)* |
| Model A (older) | `deepseek-v4-flash-0731` |
| Model B (newer) | `deepseek-v4.1-flash` |
| Temperature | `0` |
| Max tokens | `1600` |
| Disable reasoning | on |

Temperature defaults to `0` because the app is asking a question about determinism. At
temperature 0 the same prompt should produce the same answer, so a divergence is a real
difference between the models rather than sampling noise.

The system prompt is fixed: *"You are a precise assistant. Answer the user's request
directly."* Both models receive the identical user message.

When **Disable reasoning** is on, the request carries
`chat_template_kwargs: {"enable_thinking": false}`.

### Using a different provider

Any OpenAI-compatible endpoint works. Change **Base URL** and the two model names:

| Provider | Base URL |
| --- | --- |
| particle.ai (default) | `https://api.particle.ai/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Local llama.cpp / Ollama | `http://localhost:11434/v1` |

Press **Test connection** after changing anything — it will tell you whether the base URL
or the model name is the problem.

---

## Presets

Eleven presets, grouped by **what the particle cloud will probably do** — because that is
the thing worth choosing between. Each button shows the verdict it expects and a one-line
description of the two shapes.

| Group | Preset | Expect | What you see |
| --- | --- | --- | --- |
| Likely identical | Recursion, one sentence | IDENTICAL | a paragraph → the same paragraph |
| Likely identical | Capital of France | IDENTICAL | a tiny cloud → the same tiny cloud |
| Likely identical | Count to five | IDENTICAL | one short line → the same line |
| Likely different shapes | Cat in ASCII | DIVERGED | line art → line art |
| Likely different shapes | House in ASCII | DIVERGED | roof and walls → a different roof |
| Likely different shapes | HELLO in block letters | DIVERGED | wide blocks → wide blocks |
| Likely different shapes | Count to 20, one per line | DIVERGED | a tall column → short wide rows |
| Likely different density | Haiku, rain on a window | DIVERGED | three short lines → three short lines |
| Likely different density | Ocean in 200 words | DIVERGED | a dense wall → a denser wall |
| Likely different density | Python reverse function | DIVERGED | a few lines of code → more lines |
| Likely different density | Planets table | DIVERGED | a grid → a different grid |

**These labels are expectations, not guarantees.** The verdict and both clouds depend
entirely on what the two models actually return. Short factual answers usually come back
byte-identical and open-ended ones usually do not, but a real model can surprise you —
and when it does, that is the finding, not a bug. The app always reports what really
happened.

Presets are defined in one place, `src/lib/presets.ts`, and exported both as groups (for
the UI) and flat (`ALL_PRESETS`, for anything that just needs the list).

---

## Project structure

```
src/
  App.tsx                  state machine, run orchestration, HUD, console
  main.tsx                 React root
  styles.css               design tokens and all styling
  components/
    SettingsPanel.tsx      connection settings + Test connection
    ModelColumn.tsx        per-model latency, tokens, reasoning count, digest
    DiffStrip.tsx          per-character diff — one tick per character position
    RunHistory.tsx         one chip per run, so a session accumulates a tally
  lib/
    api.ts                 settings persistence, compare + test-connection requests
    presets.ts             the preset library
    sampler.ts             text → offscreen canvas → sampled particle positions
    particles.ts           three.js scene, particle pool, shader, morph, lock
server/
  index.ts                 POST /api/compare, POST /api/test-connection, GET /api/health
  model-client.ts          fetch to /chat/completions, retry, usage extraction, probe
  hash.ts                  sha256 and nonce generation
  types.ts                 wire types shared with the browser
```

### The diff strip

The signature UI element is a per-character sha256 diff: one tick per character position,
lit where the two answers differ. On an `IDENTICAL` run the strip is **completely dark** —
a second, independent confirmation of the verdict that does not rely on reading a number.

---

## HTTP API

### `POST /api/compare`

```jsonc
// request
{
  "prompt": "Explain recursion in exactly one sentence, no examples.",
  "settings": {
    "baseUrl": "https://api.particle.ai/v1",
    "apiKey": "sk-…",
    "modelA": "deepseek-v4-flash-0731",
    "modelB": "deepseek-v4.1-flash",
    "temperature": 0,
    "maxTokens": 1600,
    "disableReasoning": true
  }
}
```

```jsonc
// response
{
  "runId": "07d6d751-e222-…",
  "nonce": "8f3a91c2",
  "prompt": "Explain recursion in exactly one sentence, no examples.",
  "hashEqual": true,
  "identical": true,
  "a": { "slot": "A", "model": "…", "content": "…", "sha256": "50faef65…",
         "latencyMs": 812, "promptTokens": 34, "completionTokens": 41,
         "reasoningTokens": 0, "retried": false, "attempts": 1 },
  "b": { "slot": "B", "…": "…" }
}
```

Prompt is capped at 8,000 characters; a missing `apiKey` is a 400. Provider failures come
back with the provider's own error text verbatim.

### `POST /api/test-connection`

Always answers 200 with a per-model report — a failed probe is a result, not a server
error, because the settings panel needs both outcomes side by side.

```jsonc
{
  "ok": false,
  "baseUrl": "https://api.particle.ai/v1",
  "a": { "slot": "A", "model": "…", "ok": true,  "latencyMs": 412,
         "servedModel": "…", "sample": "ready", "reasoningTokens": 0, "error": null },
  "b": { "slot": "B", "model": "…", "ok": false, "latencyMs": 388,
         "servedModel": null, "sample": null, "reasoningTokens": 0,
         "error": { "message": "The provider does not recognise the model \"…\".",
                    "status": 404, "providerBody": "…" } }
}
```

### `POST /api/digest`

Echoes `sha256` of a supplied string, so a digest can be checked independently.

### `GET /api/health`

`{ "ok": true }`.

---

## Verification

The behaviour below was measured while this app was built, against a local
OpenAI-compatible endpoint standing in for the real provider. That endpoint is **not part
of this app** — it was deleted along with the test harness, so nothing here can run
without a real API key.

| Check | Result |
| --- | --- |
| Identical detection | two responses with equal sha256 → `IDENTICAL`, 0 particles moved |
| Diverged detection | differing sha256 → `DIVERGED`, real morph, non-zero moved count |
| Locked cloud drift | 0.064 px over 2.5 s (measured from rendered screenshots) |
| Morph displacement | cloud centroid moved hundreds of pixels between A and B |
| Repeat stability at temperature 0 | 5/5 identical verdicts, a fresh nonce on every call |
| `reasoning_content` leakage | none — never read, logged, or rendered |
| Empty-content retry | first attempt empty → retried once with a doubled budget |
| Connection test | success, 401, 404-model, and unreachable-host paths all classified correctly |
| Alias detection | an aliasing endpoint → `sameModelId: true` + warning; a well-behaved one → no warning |
| Layout | no overflow, clipping, or panel collisions at 1600, 1280, 900, 390 px |

### A measurement gotcha worth knowing

The obvious way to verify the cloud is to call `gl.readPixels` on the WebGL canvas. It
returns **all zeros**, because the drawing buffer is not preserved after compositing.
Measurements have to come from actual screenshots. If you write tests for this app, do not
trust a back-buffer read.

---

## Fork and contribute

```bash
git clone <your-fork>
cd token-morph
npm install
npm run dev
```

You will need an API key from any OpenAI-compatible provider to exercise the app.

### Before opening a PR

```bash
npm run typecheck   # must be clean
npm run build       # must succeed
```

Then verify by hand that:

- an `IDENTICAL` run still shows **0 particles moved** and the cloud does not drift
- a `DIVERGED` run still morphs, and the counter is non-zero
- **Test connection** still distinguishes a bad key from a bad model name
- the layout holds at 1600px and at 390px

### Codebase conventions

- **Types are the contract.** `server/types.ts` is shared with the browser; changes there
  ripple into both.
- **Never add `reasoning_content` to a type.** The field's absence is the safety
  mechanism. If you need reasoning data, use the token count.
- **The verdict is computed once, server-side.** Do not add a client-side comparison.
- **The key never leaves `localStorage` except to `localhost:3001`.** Do not log it, do not
  put it in a URL, do not add it to the JSON export (which already omits it deliberately).
- **Comments explain *why*.** The code says what it does; comments carry the reasoning that
  is not recoverable from reading it.

### Where to make common changes

| I want to… | Change |
| --- | --- |
| Add a preset | `src/lib/presets.ts` — the UI picks it up automatically |
| Change the particle look | the shader strings at the top of `src/lib/particles.ts` |
| Change the morph feel | `easeInOutCubic` / the burst envelope in `particles.ts`'s `loop()` |
| Support a new provider quirk | `server/model-client.ts` — the single place that talks HTTP |
| Change what counts as "identical" | the `hashEqual` line in `server/index.ts` |
| Restyle | `src/styles.css` — all tokens are CSS custom properties at the top |

---

## Feature ideas

Roughly in order of value-to-effort:

**Small, high value**

- **Export a shareable image.** Render the locked frame to a PNG with the prompt, verdict,
  both digests, and a link. This is the single biggest growth lever — the frozen frame is
  the whole product, and right now it cannot leave the browser.
- **URL-encoded runs.** Serialise a run into the query string so a result can be linked.
- **Diff the answers as text.** A side-by-side character diff next to the particle clouds,
  for when the difference is one word in 400.
- **Copy both answers.** Currently only the run JSON is copyable.

**Medium**

- **N-way comparison.** Three or four models at once, morphing A → B → C → D. The pool
  already supports it; the state machine and the HUD do not.
- **A "sameness score" across many prompts.** Run 20 prompts and report the identical
  rate as a single percentage — "these two models agree on 14 of 20 prompts" is a much
  stronger claim than one run.
- **Streaming.** Show the cloud forming as tokens arrive, rather than after the whole
  answer lands.
- **Persist run history.** History is in-memory today; `localStorage` or IndexedDB would
  let a session survive a refresh.

**Larger**

- **Semantic comparison.** Identical bytes is a binary signal. An embedding distance would
  let the app say "same meaning, different words" — which is the more interesting question
  for models that are *nearly* the same.
- **Server-side rendering of the cloud.** Render the particle layout to an image on the
  server so a run can be shared as a static OG image without a browser.
- **A public leaderboard.** Which model pairs are most often identical, aggregated across
  users. This needs a database and a privacy story, so it is a real project.

---

## Non-goals

No auth, no database, no deployment, no chat history, no multi-turn, no external APIs or
search, and no offline or simulated mode. One prompt in, one comparison out.
