# Pattern: Content Moderation Policy with Strands Decider 2B

A reusable decision pattern for classifying user-submitted content into
`hide` / `ok` using Strands Decider 2B as the policy engine.

**Decision pattern:** `#policy`
**Why a decision model:** Frontier LLMs trip guardrails on the exact content
you're trying to moderate. Decider returns a calibrated probability on any
input, every time, without generating output tokens about the content itself.

---

## The pattern

Two questions, one POST. Both decisions in a single round-trip.

```typescript
// Question 1: Is this content empty/test/placeholder with no real value?
const NO_VALUE_QUESTION = {
  type: 'choice',
  instructions:
    'You are reviewing user-submitted content. ' +
    'A valid submission has SOME purpose — a message, a statement, a joke, ' +
    'an instruction, or anything a reader could act on or respond to. ' +
    'Your job is ONLY to identify obvious test submissions: content where ' +
    'someone typed placeholder text with zero intent to create real content. ' +
    'This is a very narrow category — when in doubt, the content has value.',
  criteria: {
    hide:
      'HIDE only if BOTH of these are true: ' +
      '(A) the title/heading is clearly a test/placeholder (e.g. "test", "1", ' +
      'a random keysmash), AND ' +
      '(B) the body ALSO has no real content (another placeholder, a single ' +
      'unrelated word, or text that makes clear this was never intended as ' +
      'real content). BOTH conditions must hold.',
    ok:
      'KEEP if the content has ANY real value: a recognisable word, phrase, ' +
      'or idea; any body text with meaning; anything suggesting the creator ' +
      'intended a real submission. When in doubt, keep.',
  },
};

// Question 2: Does this content express sincere real-world harm?
// IMPORTANT: Adapt the examples to YOUR content domain and policy.
// The examples below are tuned for an adult party card game.
// Replace them with examples representative of your content and harm criteria.
const HARM_QUESTION = {
  type: 'choice',
  instructions:
    'You are a content filter. Your ONLY job is to catch content that ' +
    'expresses sincere real-world hatred or personal threat — not fictional ' +
    'content, not dark humour, not controversial opinions. ' +
    'Everything else passes, no matter how offensive.',
  criteria: {
    hide:
      // USE FEW-SHOT EXAMPLES — abstract rules fail at 2B scale.
      // The model pattern-matches on concrete examples better than it
      // reasons from abstract principles. Show it what hide looks like
      // in YOUR domain. See PROMPT_EXPERIMENTS.md for evidence.
      'HIDE if the content is a sincere real-world statement of hatred or ' +
      'threat with no fictional/game/satirical framing. Examples that HIDE:\n' +
      '• [your example 1 — bare slur/hate with no context]\n' +
      '• [your example 2 — personal threat with identifying information]\n' +
      '• [your example 3 — eliminationist statement, no other framing]\n' +
      'The pattern: bare hatred/threat with nothing fictional around it.',
    ok:
      // KEEP examples are equally important — anchor what should pass.
      'KEEP if the content has any fictional, satirical, or contextual ' +
      'framing, even if the content is very offensive. Examples that KEEP:\n' +
      '• [your example 1 — same topic but with clear fictional framing]\n' +
      '• [your example 2 — controversial but clearly satirical]\n' +
      '• [your example 3 — offensive but with obvious contextual purpose]\n' +
      'When the content could plausibly serve a legitimate purpose, KEEP it.',
  },
};
```

---

## Wiring it into your agent

```typescript
const DECIDER_URL = process.env.DECIDER_URL ?? 'http://localhost:8000';
const DECIDER_KEY = process.env.DECIDER_KEY ?? '';
const DECIDER_MODEL = process.env.DECIDER_MODEL ?? 'strands-decider';

// Thresholds — tune these against YOUR eval dataset.
// These are NOT universal values. See "Tuning thresholds" below.
const NO_VALUE_THRESHOLD = parseFloat(process.env.NO_VALUE_THRESHOLD ?? '0.36');
const HARM_THRESHOLD = parseFloat(process.env.HARM_THRESHOLD ?? '0.55');

async function shouldHide(
  title: string,
  body: string
): Promise<{ hide: boolean; confidence: number; reason: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (DECIDER_KEY) headers['Authorization'] = `Bearer ${DECIDER_KEY}`;

  const resp = await fetch(`${DECIDER_URL}/v1/systemone`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: DECIDER_MODEL,
      state: `${title}\n${body}`.trim(),
      questions: {
        no_value: NO_VALUE_QUESTION,
        harm: HARM_QUESTION,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) throw new Error(`Decider returned HTTP ${resp.status}`);
  const data = await resp.json() as any;

  const nvScore   = data.answers?.no_value?.probabilities?.hide ?? 0;
  const harmScore = data.answers?.harm?.probabilities?.hide    ?? 0;

  if (nvScore >= NO_VALUE_THRESHOLD) {
    return { hide: true, confidence: nvScore, reason: 'no-value' };
  }
  if (harmScore >= HARM_THRESHOLD) {
    return { hide: true, confidence: harmScore, reason: 'harm' };
  }
  return { hide: false, confidence: Math.max(nvScore, harmScore), reason: 'ok' };
}
```

---

## Tuning thresholds

**Do not use the threshold values from this repo directly.** They are calibrated for
BWC's specific content distribution. Your content will have a different score
distribution.

The reason two thresholds exist: the no-value and harm criteria produce different
score distributions. In our eval:
- No-value: test cards score 0.37–0.49; real cards score <0.36
- Harm (v4 few-shot): genuine hides score 0.58–0.86; ok cards score 0.36–0.52

Run the eval scripts against your labelled dataset and inspect the distributions:

```bash
# 1. Build a labelled dataset (JSON array of {id, title, body, expected: "hide"|"ok"})
# 2. Run the agent against it
# 3. Plot or inspect the score distributions per label
# 4. Find the threshold that gives your target precision/recall tradeoff
```

For content moderation, **recall matters more than precision** — it's cheaper to
review a false positive than to miss a genuine harm. Set your threshold accordingly
and let humans handle the edge cases.

---

## Writing effective criteria

The single most important thing we learned:

> **At 2B scale, few-shot examples outperform abstract rules.**

The model pattern-matches on concrete examples. It does not reliably reason from
abstract principles like "not as satire or historical reference."

**Abstract rule (0/7 recall on our probe set):**
```
HIDE only if the card explicitly calls for the elimination of a real ethnic group
as a direct command — not as satire, historical reference, or game mechanic.
```

**Few-shot (7/7 recall, same probe set):**
```
HIDE if the content is a sincere real-world statement of hatred.
Examples that HIDE:
• '[hate group] / [genocidal statement]' — genocidal statement, no game mechanic
• '[racial slur] / [racial slur]' — slur with no game context
Examples that KEEP:
• '[dark historical reference] / Everyone loses all their points' — game mechanic
```

Provide 3–5 hide examples and 3–5 ok examples covering your key edge cases.
The examples are doing the work.

---

## Why this works for sensitive content

Frontier LLMs refuse to engage with slurs and hate speech — their safety guardrails
fire on the input before they can return a useful verdict. This gives you hard errors,
no calibrated confidence, and inconsistent behaviour across model versions.

Strands Decider never generates text. It reads the content as `state` and returns a
probability distribution. No output token generation = no guardrail trigger path.
You get a consistent, calibrated result on any input.

This is not a workaround. It is the architecturally correct tool for this task.

---

## Files in this repo

| File | What it is |
|---|---|
| `agent/main.ts` | Full working implementation for BWC |
| `evaluators/dataset.json` | 40-card labelled ground truth (example, replace with your own) |
| `evaluators/run-ts-eval.py` | Eval script — reports P/R/F1 against your labelled set |
| `evaluators/prompt-experiment.py` | Test criteria variants against a probe set before full eval |
| `evaluators/PROMPT_EXPERIMENTS.md` | Full experiment history — 5 variants, findings, decision |
