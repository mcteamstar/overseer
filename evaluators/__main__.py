"""Overseer evaluation CLI.

Usage:
    python -m evaluators <command> [options]

Commands:
    probe      Test production criteria against the probe card set
    eval       Eval against a labelled dataset (reports P/R/F1)
    fulldeck   Score all cards from the BWC CDN
    fetch      Fetch the BWC deck to a local JSON file
"""

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .criteria import HARM_QUESTION, HARM_THRESHOLD, NO_VALUE_THRESHOLD
from .probe import PROBE_CARDS

# ── Config ─────────────────────────────────────────────────────────────────────

DECIDER_URL = os.environ.get("DECIDER_URL", "http://localhost:8000/v1/systemone")
DECIDER_KEY = os.environ.get("DECIDER_KEY", "")
DECIDER_MODEL = os.environ.get("DECIDER_MODEL", "strands-decider")
AGENT_URL = os.environ.get("AGENT_URL", "http://localhost:8090/invocations")
DECK_CDN = "https://blankwhite.cards/decks/global.json"

EVALUATORS_DIR = Path(__file__).parent
RESULTS_DIR = EVALUATORS_DIR / "results"


# ── Shared helpers ─────────────────────────────────────────────────────────────

def decider_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if DECIDER_KEY:
        h["Authorization"] = f"Bearer {DECIDER_KEY}"
    return h


def score_via_decider(title: str, description: str) -> float:
    state = f"{title}\n{description}"
    payload = {
        "model": DECIDER_MODEL,
        "state": state,
        "questions": {"harm": HARM_QUESTION},
    }
    with httpx.Client() as client:
        resp = client.post(DECIDER_URL, json=payload, headers=decider_headers(), timeout=60)
    resp.raise_for_status()
    return float(resp.json()["answers"]["harm"]["probabilities"]["hide"])


def score_via_agent(client: httpx.Client, card_id: int | str, title: str, description: str) -> float:
    resp = client.post(
        AGENT_URL,
        json={"items": [{"id": card_id, "fields": {"title": title, "description": description}}]},
        headers={"x-amzn-bedrock-agentcore-runtime-session-id": f"eval-{card_id}"},
        timeout=60,
    )
    resp.raise_for_status()
    return float(resp.json()["results"][0]["score"])


def score_batch_via_agent(client: httpx.Client, cards: list[dict]) -> dict:
    """Score multiple cards in one request. Returns {card_id: score}."""
    items = [{"id": c["id"], "fields": {
        "title": c["content"]["title"],
        "description": c["content"].get("description", ""),
    }} for c in cards]
    resp = client.post(
        AGENT_URL,
        json={"items": items},
        headers={"x-amzn-bedrock-agentcore-runtime-session-id": f"eval-batch-{cards[0]['id']}"},
        timeout=120,
    )
    resp.raise_for_status()
    return {r["id"]: float(r["score"]) for r in resp.json()["results"]}


def bucket(card: dict, seed: int = 42, tf: float = 0.30) -> str:
    h = hashlib.md5(f"{seed}:{card['id']}".encode()).hexdigest()
    return "test" if int(h, 16) % 100 < tf * 100 else "train"


def print_metrics(r: dict) -> None:
    gate_str = "✓ PASS" if r["gate"] else "✗ FAIL"
    print(f"\n{'='*60}")
    print(f"n={r['n']}  TP={r['tp']} FP={r['fp']} FN={r['fn']} TN={r['tn']}")
    print(f"Precision: {r['precision']:.1%}")
    print(f"Recall:    {r['recall']:.1%}")
    print(f"F1:        {r['f1']:.3f}  {gate_str}")
    print(f"Time:      {r['elapsed_secs']:.0f}s ({r['secs_per_card']:.1f}s/card)")
    errors = r.get("errors", [])
    fns = [e for e in errors if e["type"] == "FN"]
    fps = [e for e in errors if e["type"] == "FP"]
    if fns:
        print(f"\n🔴 FALSE NEGATIVES ({len(fns)}):")
        for e in fns:
            print(f"  [{e['id']}] score={e['score']} — {e['title']!r}")
            if e.get("reason"):
                print(f"         reason: {e['reason']}")
    if fps:
        print(f"\n🟡 FALSE POSITIVES ({len(fps)}):")
        for e in fps:
            print(f"  [{e['id']}] score={e['score']} — {e['title']!r}")


# ── probe ──────────────────────────────────────────────────────────────────────

def cmd_probe(args: argparse.Namespace) -> None:
    """Test production harm criteria against the probe card set via Decider directly."""
    print(f"Decider:   {DECIDER_URL}")
    print(f"Model:     {DECIDER_MODEL}")
    print(f"Threshold: {HARM_THRESHOLD}")
    print(f"Cards:     {len(PROBE_CARDS)}\n")

    results = []
    for card in PROBE_CARDS:
        t0 = time.perf_counter()
        score = score_via_decider(card["title"], card["description"])
        elapsed = time.perf_counter() - t0
        predicted = "hide" if score >= HARM_THRESHOLD else "ok"
        correct = predicted == card["expected"]
        results.append({**card, "score": round(score, 4), "predicted": predicted,
                        "correct": correct, "latency_ms": round(elapsed * 1000)})
        print(
            f"  {'✓' if correct else '✗'} [{card['cat']:10s}] [{card['id']:4}] "
            f"score={score:.4f} → {predicted:<4}  (expected={card['expected']})  {card['note']}"
        )

    n = len(results)
    correct_count = sum(1 for r in results if r["correct"])
    hide_r = [r for r in results if r["expected"] == "hide"]
    ok_r = [r for r in results if r["expected"] == "ok"]

    print(f"\n{'='*60}")
    print(f"Results: {correct_count}/{n} correct")
    print(f"  Hide recall:    {sum(1 for r in hide_r if r['correct'])}/{len(hide_r)}")
    print(f"  Ok specificity: {sum(1 for r in ok_r if r['correct'])}/{len(ok_r)}")
    errors = [r for r in results if not r["correct"]]
    if errors:
        print("\nErrors:")
        for e in errors:
            print(f"  [{e['id']}] {e['title']!r} — score={e['score']} predicted={e['predicted']}")


# ── eval ───────────────────────────────────────────────────────────────────────

def cmd_eval(args: argparse.Namespace) -> None:
    """Eval against a labelled dataset via the agent's /invocations endpoint."""
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        print(f"Dataset not found: {dataset_path}")
        print("Run `python -m evaluators fetch` first, then annotate a sample.")
        sys.exit(1)

    with open(dataset_path) as f:
        dataset = json.load(f)

    cards = [c for c in dataset if args.split == "all" or bucket(c) == args.split]
    hide_cards = [c for c in cards if c["expected"] == "hide"]
    ok_cards = [c for c in cards if c["expected"] == "ok"]

    print(f"Agent:  {AGENT_URL}")
    print(f"Split:  {args.split} — {len(cards)} cards (hide={len(hide_cards)}, ok={len(ok_cards)})")
    print(f"Threshold: {args.threshold}\n")

    tp = fp = fn = tn = 0
    errors: list[dict] = []
    start = time.perf_counter()

    with httpx.Client() as client:
        for i, card in enumerate(cards, 1):
            score = score_via_agent(client, card["id"], card.get("title", ""), card.get("description", ""))
            predicted_hide = score >= args.threshold
            actual_hide = card["expected"] == "hide"

            if predicted_hide and actual_hide:     tp += 1
            elif predicted_hide and not actual_hide: fp += 1
            elif not predicted_hide and actual_hide: fn += 1
            else:                                  tn += 1

            if predicted_hide != actual_hide:
                errors.append({"id": card["id"], "title": card.get("title", ""),
                                "score": round(score, 4), "expected": card["expected"],
                                "type": "FP" if predicted_hide else "FN",
                                "reason": card.get("reason", "")})

            print(f"  [{i:2d}/{len(cards)}] {card['id']} score={score:.4f} "
                  f"pred={'HIDE' if predicted_hide else 'ok':<4} expected={card['expected']}", flush=True)

    elapsed = time.perf_counter() - start
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec  = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0

    result = {"split": args.split, "n": len(cards), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
              "precision": prec, "recall": rec, "f1": f1, "gate": prec >= 0.80 and rec >= 0.80,
              "elapsed_secs": elapsed, "secs_per_card": elapsed / len(cards) if cards else 0,
              "errors": errors}
    print_metrics(result)

    RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    out_path = RESULTS_DIR / f"eval-{args.split}-{ts}.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nSaved: {out_path}")


# ── fulldeck ───────────────────────────────────────────────────────────────────

def cmd_fulldeck(args: argparse.Namespace) -> None:
    """Score all cards from the BWC CDN via the agent's /invocations endpoint."""
    cache = Path("/tmp/bwc-deck-cache.json")
    partial = Path("/tmp/bwc-deck-partial.json")

    # Fetch deck (cached 1h)
    if cache.exists() and time.time() - cache.stat().st_mtime < 3600:
        print(f"Using cached deck ({cache})")
        with open(cache) as f:
            deck = json.load(f)
    else:
        print(f"Fetching deck from {DECK_CDN}...")
        with httpx.Client() as client:
            resp = client.get(DECK_CDN, timeout=30)
        deck = resp.json()["cards"]
        with open(cache, "w") as f:
            json.dump(deck, f)
        print(f"Fetched {len(deck)} cards")

    # Load labelled set for cross-reference
    dataset_path = EVALUATORS_DIR / "dataset.json"
    labelled: dict[int, dict] = {}
    if dataset_path.exists():
        with open(dataset_path) as f:
            labelled = {c["id"]: c for c in json.load(f)}
        print(f"Labelled cards: {len(labelled)}")

    # Resume
    scored: dict[int, float] = {}
    if args.resume and partial.exists():
        with open(partial) as f:
            scored = {int(k): v for k, v in json.load(f).items()}
        print(f"Resuming: {len(scored)} already scored")

    remaining = [c for c in deck if c["id"] not in scored]
    total, done = len(deck), len(scored)
    batch_size = getattr(args, "batch_size", 20)
    print(f"\nScoring {len(remaining)} remaining cards via {AGENT_URL} (batch={batch_size})...\n")
    start = time.perf_counter()

    with httpx.Client() as client:
        for batch_start in range(0, len(remaining), batch_size):
            batch = remaining[batch_start:batch_start + batch_size]
            try:
                batch_scores = score_batch_via_agent(client, batch)
            except Exception as e:
                print(f"  BATCH ERROR {batch[0]['id']}–{batch[-1]['id']}: {e}")
                batch_scores = {c["id"]: 0.0 for c in batch}

            for card in batch:
                score = batch_scores.get(card["id"], 0.0)
                scored[card["id"]] = score
                done += 1
                pred = "HIDE" if score >= NO_VALUE_THRESHOLD else "ok"
                label = ""
                if card["id"] in labelled:
                    exp = labelled[card["id"]]["expected"]
                    label = f" [{exp} {'✓' if (score >= NO_VALUE_THRESHOLD) == (exp == 'hide') else '✗'}]"
                title = card["content"]["title"][:25]
                print(f"  [{done:3d}/{total}] [{card['id']:4d}] {title:<25} "
                      f"{score:.4f} {pred:<4}{label}", flush=True)

            if done % 100 == 0:
                with open(partial, "w") as f:
                    json.dump(scored, f)
                elapsed = time.perf_counter() - start
                rate = elapsed / done
                print(f"  ... {done}/{total} done — {rate:.1f}s/card avg, ETA {rate*(total-done)/60:.0f}m")

    with open(partial, "w") as f:
        json.dump(scored, f)

    elapsed_total = time.perf_counter() - start
    hide_n = sum(1 for s in scored.values() if s >= NO_VALUE_THRESHOLD)
    n = len(scored)

    print(f"\n{'='*60}")
    print(f"Scored {n} cards in {elapsed_total/60:.1f}min")
    print(f"HIDE: {hide_n} ({hide_n/n:.1%})  ok: {n-hide_n} ({(n-hide_n)/n:.1%})")

    if labelled:
        tp=fp=fn=tn=0
        errors = []
        for cid, score in scored.items():
            if cid not in labelled:
                continue
            lbl = labelled[cid]
            ph = score >= NO_VALUE_THRESHOLD
            ah = lbl["expected"] == "hide"
            if ph and ah:      tp += 1
            elif ph and not ah: fp += 1
            elif not ph and ah: fn += 1
            else:               tn += 1
            if ph != ah:
                errors.append({"id": cid, "title": lbl.get("title",""), "score": round(score,4),
                                "expected": lbl["expected"], "type": "FP" if ph else "FN"})
        prec = tp/(tp+fp) if tp+fp else 0
        rec  = tp/(tp+fn) if tp+fn else 0
        f1   = 2*prec*rec/(prec+rec) if prec+rec else 0
        print(f"\nVs labelled ({tp+fp+fn+tn} cards):")
        print(f"  P={prec:.1%}  R={rec:.1%}  F1={f1:.3f}  "
              f"{'✓ PASS' if prec>=0.80 and rec>=0.80 else '✗ FAIL'}")

    RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    out_path = RESULTS_DIR / f"fulldeck-{ts}.json"
    with open(out_path, "w") as f:
        json.dump({"timestamp": ts, "n": n, "hide": hide_n, "scores": scored}, f, indent=2)
    print(f"Saved: {out_path}")


# ── fetch ──────────────────────────────────────────────────────────────────────

def cmd_fetch(args: argparse.Namespace) -> None:
    """Fetch the BWC deck from the CDN."""
    print(f"Fetching from {DECK_CDN}...")
    with httpx.Client(timeout=30) as client:
        resp = client.get(DECK_CDN)
        resp.raise_for_status()
        cards = resp.json()["cards"]

    out = [{"id": c["id"], "title": c["content"].get("title", ""),
            "description": c["content"].get("description", "")} for c in cards]

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {len(out)} cards to {out_path}")
    print("\nTo annotate for labelled eval:")
    print("  Add \"expected\": \"hide\" or \"ok\" and \"reason\": \"...\" to each card")
    print("  Save as evaluators/dataset.json")
    print("  Run: python -m evaluators eval")


# ── entrypoint ─────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m evaluators",
        description="Overseer evaluation tools",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # probe
    sub.add_parser("probe", help="Test criteria against the probe card set")

    # eval
    p_eval = sub.add_parser("eval", help="Eval against a labelled dataset")
    p_eval.add_argument("--dataset", default=str(EVALUATORS_DIR / "dataset.json"))
    p_eval.add_argument("--split", default="train", choices=["train", "test", "all"])
    p_eval.add_argument("--threshold", type=float, default=NO_VALUE_THRESHOLD)

    # fulldeck
    p_full = sub.add_parser("fulldeck", help="Score all cards from the BWC CDN")
    p_full.add_argument("--resume", action="store_true")

    # fetch
    p_fetch = sub.add_parser("fetch", help="Fetch the BWC deck to a local file")
    p_fetch.add_argument("--output", default="evaluators/dataset-full.json")

    args = parser.parse_args()
    {"probe": cmd_probe, "eval": cmd_eval, "fulldeck": cmd_fulldeck, "fetch": cmd_fetch}[args.cmd](args)


if __name__ == "__main__":
    main()
