# Hosting the Strands Decider endpoint

The agent calls `POST /v1/systemone` — any endpoint that speaks this schema works.
This document describes how we run it in our homelab and how you can adapt it.

## The /v1/systemone schema

```bash
curl http://your-endpoint/v1/systemone \
  -H "Authorization: Bearer $DECIDER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "strands-decider",
    "state": "card title\ncard description",
    "questions": {
      "my_question": {
        "type": "choice",
        "instructions": "...",
        "criteria": { "hide": "...", "ok": "..." }
      }
    }
  }'

# Response:
# {
#   "answers": {
#     "my_question": {
#       "probabilities": { "hide": 0.823, "ok": 0.177 }
#     }
#   },
#   "latency_ms": 450
# }
```

## Option 1 — Direct strands-decider serve (simplest)

Run `strands-decider serve` directly. No proxy layer needed.

```bash
pip install uv
uv pip install strands-decider==0.1.0

# Weights from HuggingFace:
huggingface-cli download amazon/strands-decider-2B-qwen3.5-v1-2610 --local-dir ./lora
huggingface-cli download Qwen/Qwen3.5-2B-Base --local-dir ./base

strands-decider serve ./lora \
  --base-model ./base \
  --device mps \       # mps (Apple Silicon), cuda, or cpu
  --host 127.0.0.1 \
  --port 8000
```

Set in your agent:
```
DECIDER_URL=http://localhost:8000
DECIDER_KEY=  # leave empty — strands-decider serve has no auth
```

**Hardware requirements:** The model is ~4.4GB total (4.2GB base + 200MB LoRA).
It fits comfortably on M1 8GB, M2/M3, or any CUDA GPU with 6GB+ VRAM.
CPU works but is slow (~3–5s/call).

## Option 2 — litellm proxy (what we run)

We route through [litellm](https://github.com/BerriAI/litellm) to add API key auth,
request logging, and a stable URL. litellm 1.104+ natively supports the
`/v1/systemone` endpoint for strands-decider.

**litellm config:**
```yaml
model_list:
  - model_name: strands-decider
    litellm_params:
      model: strands_decider/strands-decider-2B-qwen3.5-v1-2610
      api_base: http://127.0.0.1:8000
```

**Run litellm:**
```bash
litellm --config config.yaml --port 4000
```

Set in your agent:
```
DECIDER_URL=http://localhost:4000/v1/systemone
DECIDER_KEY=your-litellm-master-key
```

## Our homelab setup

We run this on an M1 Mac Mini (8GB unified memory) as a persistent system service:

- `strands-decider serve` runs as a LaunchDaemon (`com.supply.decide`) on port 8000, bound to `127.0.0.1`
- litellm runs as a Podman container on port 4000, proxied by Caddy on port 80
- The litellm instance is accessible at `http://your-host.your-tailnet.ts.net/v1/systemone` via Tailscale

**Working copy pattern:** Model weights live in a depot directory (`~/depot/models/`)
and are never patched. The service install script copies them to a working directory
(`~/supply/decide/model/`) and patches the config there. This keeps the depot pristine
for re-installs.

This is homelab-specific machinery. For most use cases, Option 1 (direct serve) is
all you need.

## Future: Bedrock-native endpoint

When AWS ships a Bedrock-native Strands Decider endpoint, the agent requires one
change — set `DECIDER_URL` to the Bedrock endpoint URL. The `/v1/systemone` schema
is the same. This is why we kept the HTTP abstraction rather than using the
strands-decider SDK directly.

## Latency expectations

| Hardware | Device | Latency per call (2 questions) |
|---|---|---|
| M5 Pro Mac (64GB) | MPS | ~300ms |
| M1 Mac (8GB) | MPS | ~935ms |
| CUDA GPU 16GB | CUDA | ~200–400ms (estimated) |
| CPU only | CPU | ~3–5s |

Questions are processed sequentially in one forward pass — batching 2 questions
in one HTTP call saves the round-trip but not the inference time.
