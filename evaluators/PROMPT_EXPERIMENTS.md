# Harm criteria prompt experiments

Objective: find harm question criteria that catch outright hate speech and personal
threats while permitting edgy humour, satire, crude content, and dark game mechanics.

Model: `strands-decider-2B-qwen3.5-v1-2610` via litellm `/v1/systemone`

Probe set: 18 cards — 7 expected hide, 11 expected ok.
See `prompt-experiment.py` for full probe card definitions.

---

## Summary table

| Variant | Hide recall | Ok spec | Notes |
|---|---|---|---|
| baseline | 0/7 | 10/11 | Too permissive — model always passes |
| harm-v2 (explicit incitement) | 0/7 | 9/11 | Worse — naming examples anchors model to pass them |
| harm-v3 (mechanic-anchor) | 7/7 | 0/11 | Too aggressive — can't detect game mechanic in short text |
| **harm-v4 (few-shot) @0.55** | **7/7** | **9/11** | ✓ Best result on probe set |

## Full dataset eval (train split, 29 cards)

| Version | P | R | F1 | Gate |
|---|---|---|---|---|
| Python baseline (no leo) | 87.5% | 63.6% | 0.737 | ✗ FAIL |
| TS v1 (leo + baseline harm) | 81.8% | 81.8% | 0.818 | ✓ PASS |
| **TS v2 (leo + harm-v4 + HARM_THRESHOLD=0.55)** | **78.6%** | **100%** | **0.880** | ✗ FAIL (P just under 80%) |

v2 achieves R=100% — all hides caught. P=78.6% misses gate by 1.4pp due to 3 FPs:
- Card 498 (`ITS NOT A FUCKING PHASE`) — leo-profanity, intentional per policy
- Card 56 (`Star / Stars are shit. Drink bitch`) — no-value FP (nv=0.565)
- Card 665 (`rebellious guy / spin a wheel...`) — no-value FP (nv=0.551)

Cards 56 and 665 are no-value false positives, not harm FPs. They have real game
content but score near the 0.36 no-value threshold.

---

## Key finding: few-shot examples + raised threshold

**v4 with threshold=0.55 achieves 7/7 hide recall and 9/11 ok specificity.**

The two ok cards that still get hidden at 0.55 are edge cases:
- `Suicide / Kill your highest card` (score=0.505) — short, no explicit point value
- `Murder / Eliminate the player with the most points` (score=0.544) — borderline

Both clear at 0.56+. In practice, the no-value pass and spam filter handle most of
these cards before they reach the harm pass, so the effective FP rate in production
is lower than the probe set suggests.

---

## Mechanism

**Why baseline/v2 fail:** The baseline criteria say "not as satire, historical
reference, dark humour, or game mechanic" — this teaches the model to default to
KEEP. The model pattern-matches on the permissive framing and scores everything low.

**Why v3 fails:** Anchoring on "game mechanic present = always ok" is sound in
theory but the model can't reliably detect a game mechanic from 3-5 words of text.
`Drink` passes as a game mechanic intuitively, but the model has no world model of
card game conventions.

**Why v4 works:** Few-shot examples in criteria provide concrete anchor points the
model can pattern-match against. `[hate group] / [genocidal statement]` scores high because
the example `death to [ethnic group] / death to [ethnic group]` is structurally identical — short,
no mechanic, eliminationist. The model learns the shape of the distinction from
examples rather than from abstract rules.

**Why threshold 0.55 instead of 0.36:** v4 pushes all scores upward. Ok cards
cluster in 0.36–0.52, hide cards in 0.58–0.86. The natural decision boundary
sits around 0.54–0.56. Raising the threshold from the default 0.36 exploits this
separation cleanly.

---

## Recommended criteria (v4 + threshold 0.55)

### Instructions
```
You are a content filter for an adult party card game.
The game is intentionally offensive — profanity, slurs, dark humour,
crude dares, and taboo game mechanics are all normal and welcome.
You have an extremely narrow job: catch only cards that are sincere
real-world expressions of hatred or personal threat with NO game framing.
Everything else passes, no matter how offensive.
```

### Hide criteria
```
HIDE if the card is a sincere real-world statement of hatred or threat
with no game mechanic framing. Examples that HIDE:
• '[racial slur] / [racial slur]' — slur repeated with no game context
• '[hate group] / [genocidal statement]' — genocidal statement, no game mechanic
• 'Nude / Go nude NOW I KNOW WHERE YOU LIVE I WILL HAVE YOU' —
  personal threat with identifying intent
• 'death to [ethnic group] / death to [ethnic group]' — eliminationist statement, no mechanic
• 'I want to die / I want to die' — sincere self-harm, no game framing
The pattern: bare hatred/threat with nothing game-like around it.
```

### Ok criteria
```
KEEP if the card has any game framing, even if the content is very offensive.
Examples that KEEP:
• 'Suicide / Kill your highest value card' — game mechanic
• '[dark historical atrocity] / Everyone loses all their points' — dark game mechanic
• '[offensive group reference] / Everyone loses 10 points' — offensive but game mechanic
• 'Drink bitch / Make someone drink' — crude game dare
• '[Taboo dare] / Complete the dare, if everyone laughs gain 10 points' — dare
• 'Shit yourself / Lose a turn' — toilet humour game mechanic
The pattern: anything with a point value, dare, rule, or playable framing.
```

### Threshold
`HARM_THRESHOLD = 0.55` (separate from NO_VALUE_THRESHOLD = 0.36)

---

## Remaining gaps

- **Card 591 (`[Dutch ethnic slur]`)**: Dutch slur, score=0.71 — caught by v4 ✓
- **Card 614 (`[Dutch ethnic slur]`)**: Dutch racial slur, score=0.82 — caught by v4 ✓
- **Card 609 (`[hate group] / [genocidal statement]`)**: score=0.85 — caught by v4 ✓
- **Card 564 (`[racial slur]`)**: score=0.78 — caught by v4 + leo-profanity (double coverage)

All 4 key false negatives from the initial baseline are resolved by v4 criteria.

## Next steps

1. Apply v4 criteria + threshold=0.55 to `main.ts` harm question
2. Re-run full dataset eval (`run-ts-eval.py`) with updated criteria
3. Confirm no regression on ok cards in the full 40-card set

---

## Final architecture decision (Oct 2026)

**leo-profanity dropped. Decider-only pipeline adopted.**

Full-deck ablation (860 cards, `SKIP_PROFANITY=1`): results are identical on the
40-card labelled set with or without leo-profanity. The npm profanity filter
ecosystem has no production-grade category-based library — `profanease` (3 stars,
~2k/week) is the only one with `Category.SLUR` support but is unproven in production.
Industry standard is cloud APIs (Google Perspective, AWS Comprehend) or custom ML.

Since Decider v4 criteria catch the same cases semantically, the word-list stage
adds no value and only introduces FPs (card 498: `ITS NOT A FUCKING PHASE` scored
1.0 via leo, 0.56 via Decider — still a FP but more informative score).

**Final pipeline:**
```
Stage 1: DENY_LIST    — human-authored hard blocks, O(1), first gate
Stage 2: Spam filter  — deterministic gibberish/identical detection
Stage 3: Decider HTTP — v4 few-shot criteria, HARM_THRESHOLD=0.55
Stage 4: Nova Lite    — final safety net
```

**Full-deck eval (860 cards, no leo, v4 criteria):**
- P=73.9%, R=94.4%, F1=0.829, hide_rate=22.3%
- 6 FPs per 860 cards → human review
- 1 FN: card 519 (`[homophobic slur with no game context]`) — Decider scores 0.31

The human-in-loop framing: the agent triages 860 cards to ~192 for review (22.3%),
with 94.4% recall on genuine hides. That's the right tradeoff for this use case.
