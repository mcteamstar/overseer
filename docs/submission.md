# Moderating an Adult Card Game at Scale with Strands Decider

**Tags:** #strands-decider-2b #policy  
**Decision pattern:** `#policy` — classify an incoming card before the agent acts on it

---

[Blank White Cards](https://blankwhite.cards) is a party card game where players write and draw their own cards. It's intentionally adult — dark humour, crude content, and offensive jokes are part of the experience. But every so often someone submits something that crosses into genuine hate speech, personal threats, or content that has no place in any game. Those cards need to come out.

The game has been running for a few years now. We have 860 community cards and the deck keeps growing. Keeping it clean is a real ongoing job.

---

## The existing solution — and why it doesn't scale

My first moderation agent used Amazon Nova Lite to review each card. Pass it the title and description, ask whether it should be hidden, parse the response. It worked well enough at low volume — but it had two problems that compounded as the deck grew.

The first is cost and speed. Nova Lite isn't expensive per call, but running it across hundreds of cards repeatedly adds up. More importantly, it's slow enough that running a full-deck sweep feels like a commitment. You do it occasionally, not continuously.

The second problem is more fundamental: **Nova's own safety guardrails fire when it processes the content you're trying to moderate.** Show it a card containing a slur or a credible threat, and instead of a moderation verdict, you get a refusal exception. My original agent treated that exception as a heuristic hide signal — if Nova refused to engage, the card probably needed hiding. Which works some of the time, but it's a proxy. A dark joke might trip the guardrail. A carefully constructed piece of hate speech that avoids the obvious triggers might sail right through. Either way you get a binary exception with no confidence, no reasoning, and no threshold to tune.

You end up fighting your own model to build safety tooling.

---

## Strands Decider changes the picture

I went to AWS Community Day Brisbane earlier this year, where Mike Chambers talked about Strands Decider — a small model built specifically for decisions. It doesn't generate text. It reads a situation, answers a typed question, and returns a probability. I left the talk wanting to try it, and had a working prototype by the end of the day.

The fit for content moderation is almost exact. Strands Decider reads the card as `state`, receives a choice question, and returns a calibrated score between zero and one. No token generation means no guardrail trigger path. You can show it the most hateful content in the deck and it will return 0.85 without flinching. No exception, no refusal — just a number.

That's not just convenient. It's architecturally necessary. The content you're moderating is exactly what LLM safety systems are designed to refuse to process. A decision model sidesteps that entirely.

---

## The moderation pipeline

The pipeline has four stages that exit early as soon as they're confident:

```
Stage 1: DENY_LIST      ~0ms      Human-authored hard blocks. O(1) lookup.
Stage 2: Spam filter    ~0ms      Deterministic: gibberish, empty, identical.
Stage 3: Decider 2B     ~935ms    Combined no-value + harm in one POST.
Stage 4: Nova Lite      ~800ms    Bedrock fallback. Rarely reached.
```

Most cards exit at stages one or two. Decider only runs on the ones that make it through. Two questions — one checking for no-value test cards, one checking for sincere harm — go in a single POST and return two independent scores, each with its own threshold. Nova Lite remains as a safety net but rarely fires.

When a card is hidden, the agent calls `hide_cards` on the AgentCore egress gateway to execute the action, and `send_alert` to notify the operations team. Both are MCP tool calls signed with SigV4 — the agent acts on its decisions rather than just returning them.

---

## Deployment architecture

The agent is deployed as a container on Amazon Bedrock AgentCore in `ap-southeast-2`. Because Strands Decider 2B isn't yet available on Bedrock directly, the container reaches the self-hosted inference endpoint privately over Tailscale.

### AgentCore container runtime

```
┌─────────────────────────────────────────────────────────────┐
│  AgentCore Runtime: overseer_moderator                       │
│  Container (linux/arm64) — Node.js 22                        │
│                                                              │
│  start.sh                                                    │
│  ├── tailscaled --outbound-http-proxy-listen=:1080           │
│  ├── tailscale up --hostname=overseer-agentcore              │
│  └── exec node main.js                                       │
│                                                              │
│  main.js                                                     │
│  ├── POST /invocations → scoreItem() pipeline                │
│  ├── Decider calls: undici → ALL_PROXY=http://localhost:1080 │
│  ├── Nova calls: BedrockRuntimeClient (inference profile)     │
│  └── Gateway calls: MCP SigV4 → hide_cards            │
│                               → send_alert     │
└─────────────────────────────────────────────────────────────┘
```

### Network path: agent → Decider

Strands Decider 2B runs on an M1 Mac Mini (8GB unified memory, Metal GPU), served by llama-cpp through litellm, behind Caddy. The container reaches it over Tailscale:

```
AgentCore container
  │
  │  ALL_PROXY=http://localhost:1080
  ▼
tailscaled (userspace-networking)
  │
  │  Tailscale DERP relay (TCP/HTTPS — UDP blocked in container)
  │  tag:overseer → tag:supply:80 ACL
  ▼
your-decider-host (inference server)
  │
  ├── Caddy :80 → litellm :4000
  └── litellm → strands-decider :8000 (llama.cpp, Metal GPU)
```

**Key detail:** Node's native `fetch` ignores `ALL_PROXY` / `HTTP_PROXY` env vars. The fix is `undici`'s `EnvHttpProxyAgent`, which routes through tailscaled's HTTP CONNECT proxy at `:1080`. Without this, Decider calls fail silently even when Tailscale is connected.

**Tailscale cold start:** The container loads a pre-authenticated state blob (`TS_STATE`) from SSM SecureString rather than running a fresh auth flow. This reduces Tailscale connect time from ~6 minutes (full DERP auth via TCP/HTTPS) to ~8 seconds (re-establishing an existing DERP session). The state is generated once in a Linux container, base64-encoded, and stored in SSM.

### Secrets and configuration

```
SSM SecureString (ap-southeast-2)
├── /overseer/DECIDER_KEY     — litellm bearer token
├── /overseer/TS_AUTHKEY      — Tailscale ephemeral auth key
├── /overseer/TS_STATE        — pre-authenticated Tailscale state (base64)
└── /overseer/NOVA_MODEL_ID  — Nova Lite inference profile

IAM execution role
└── AgentCore-YourStack-ApplicationRuntimeRole
    ├── AmazonEC2ContainerRegistryReadOnly
    └── AmazonBedrockFullAccess
```

### AgentCore gateway integration

The agent calls out to the AgentCore egress gateway for its actions:

```
AgentCore container
  │
  │  MCP tools/call (SigV4-signed HTTPS)
  ▼
agentcore-egress-gateway (ap-southeast-2)
  │
  ├── hide_cards
  │     └── Lambda → WhiteApiStack-ModerateHandler (eu-central-1)
  │                   → hides card in BWC database
  │
  └── send_alert
        └── Lambda → SNS publish → ohnomer-alerts topic
                      → relay webhook → ops notification
```

Cedar policies on the egress policy engine control what the agent is allowed to call. Currently set to `LOG_ONLY` (shadow mode — calls are evaluated and logged but not enforced) while we validate the end-to-end flow before enabling live actions.

---

## Cheaper, faster, and you can run it endlessly

The practical upside of this architecture is that running it costs almost nothing. A full sweep of 860 cards takes about 15 minutes and the marginal cost on self-hosted hardware is electricity. With Nova Lite you'd think twice about running it daily. With Decider you can run it continuously.

That repeatability matters. The deck grows. Cards slip through that shouldn't. Edge cases emerge. Being able to re-evaluate the full deck overnight without worrying about cost means moderation becomes an ongoing process rather than a periodic event. The 860-card evaluation I ran against known ground truth returned 96.7% recall — 29 of 30 known violations caught, ~104 cards flagged for human review.

It also opened up image moderation. Some cards have hand-drawn images — a card with an innocuous title but a hate symbol in the drawing. Strands Decider 2B has a vision tower. Pass it a base64-encoded image alongside the text and it examines both, same guardrail-free property. Running image evaluation across 848 image cards took a few hours on the M1 and cost nothing. With a frontier model that would be expensive and rate-limited.

(One thing worth noting if you're self-hosting Decider behind litellm: make sure `drop_params` is not set to `true` in your config. It will silently strip the `images` field before forwarding to Decider, making all your vision calls text-only with no error. Cost me more time than I'd like to admit.)

---

## What this opens up

Right now moderation runs as a batch job. But Decider is fast enough — ~935ms end-to-end through litellm — that you could call it inline during a game session. Every card played, moderated in real time before it appears on other players' screens.

That's a fundamentally different product. Batch moderation catches violations after the fact. Real-time moderation means a hate card never makes it to another player's hand at all. With a generative model that path was too slow and too expensive to be practical. With a decision model it's within reach.

---

## What I learned

Small models trained for a specific task outperform large general models at that task. Strands Decider 2B running on 8GB of unified memory, on hardware that costs nothing to run, returns better moderation decisions than Nova Lite running on Bedrock — because it was built for this.

The second thing I learned is about the operational path. Deploying a container to AgentCore that calls a self-hosted endpoint is not a trivial operation. Tailscale userspace networking in a container without UDP access takes specific wiring: `--outbound-http-proxy-listen` on tailscaled, `undici` instead of native `fetch`, pre-authenticated state to avoid a 6-minute cold start. None of this is documented anywhere — you find it by reading logs.

When Strands Decider 2B is available on Bedrock, all of that disappears. `DECIDER_URL` points at a Bedrock endpoint, the Tailscale config is removed, and the cold start is a non-issue. The architecture is designed for that transition — it's a config change, not a rewrite.

The third thing: **human review is not optional.** The agent is a triage tool. It surfaces likely violations at a threshold where false positives are acceptable, and a human makes the final call. The false positive rate (~12% at the 0.65 threshold) is high enough that automating the hide action without review would hide cards that shouldn't be hidden. The Cedar policy enforcement mode makes this concrete — the agent is wired to call `hide_cards` but the policy gate is kept in shadow mode until we're confident in the calibration.

---

## Reusable pattern

The short version: put Decider before any generative model. It never trips guardrails, returns a calibrated score you can threshold, and runs fast enough to use inline. Write your criteria as concrete examples rather than abstract rules — at 2B scale the model pattern-matches on shape, not principle. Keep a human-authored deny list for confirmed misses rather than trying to get the model to cover every edge case. And if you're adding image moderation, run the image question as a separate call — image tokens bleed into text question calibration if you combine them in one POST.
