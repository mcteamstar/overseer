/**
 * moderator-ts — TypeScript implementation of the BWC content moderation pipeline.
 *
 * Pipeline:
 *   Stage 1: Deny-list           (~0ms, human-authored hard blocks from config)
 *   Stage 2: Spam filter         (~0ms, deterministic gibberish/identical detection)
 *   Stage 3: Decider HTTP        (~935ms+, questions loaded from config, text + optional image call)
 *   Stage 4: Nova Lite (Bedrock) (~800ms, final safety net, rarely reached)
 *
 * Configuration: CONFIG_PATH env var (default: ./moderation.config.yaml)
 * Architecture: see docs/submission.md
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PNG } from 'pngjs';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ── Config schema ─────────────────────────────────────────────────────────────

interface QuestionConfig {
  name: string;
  threshold: number;
  action: 'hide' | 'flag' | 'allow';
  image_only: boolean;
  type: 'choice';
  instructions: string;
  criteria: { hide: string; ok: string };
}

interface ModerationConfig {
  version: number;
  state_template: string;
  image_field: string | null;  // which field contains the image data (null = no image)
  deny_list: string[];
  questions: QuestionConfig[];
}

function loadConfig(configPath: string): ModerationConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8')) as ModerationConfig;
  if (!raw.questions || !Array.isArray(raw.questions)) {
    throw new Error('Config must have a questions array');
  }
  if (typeof raw.state_template !== 'string') {
    throw new Error('Config must have a state_template string');
  }
  return {
    version: raw.version ?? 1,
    state_template: raw.state_template,
    image_field: raw.image_field ?? null,
    deny_list: raw.deny_list ?? [],
    questions: raw.questions,
  };
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? './moderation.config.yaml';
const config = loadConfig(CONFIG_PATH);
console.info(`[moderator-ts] Loaded config from ${CONFIG_PATH} (${config.questions.length} questions)`);

// ── Env config ────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION ?? 'ap-southeast-2';
const DECIDER_URL = process.env.DECIDER_URL ?? 'http://localhost:8000/v1/systemone';
const DECIDER_KEY = process.env.DECIDER_KEY ?? '';
const DECIDER_MODEL = process.env.DECIDER_MODEL ?? 'strands-decider';
// Nova model — read from SSM at deploy time
// via NOVA_MODEL_ID env var, or fall back to the direct regional model.
const NOVA_MODEL_ID = process.env.NOVA_MODEL_ID ?? 'amazon.nova-lite-v1:0';
// Egress gateway — tool calls (hide_cards, send_alert)
const EGRESS_GATEWAY_ID = process.env.EGRESS_GATEWAY_ID ?? 'YOUR_EGRESS_GATEWAY_ID';
const EGRESS_GATEWAY_URL = `https://${EGRESS_GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp`;


// ── BWC image decompression ───────────────────────────────────────────────────
// BWC stores card images as RLE + UTF-16 (charCode - 32 = run length).
// Runs alternate white/black starting white. Output: 500×500 1-bit greyscale.
// Source: mcteamster/white/app/src/lib/images.ts — decompressImage()

const BLANK_COMPRESSED_IMAGE = '썰 썰 썰 썰 썰';

function decompressBwcImage(compressed: string): Buffer | null {
  if (!compressed || compressed === BLANK_COMPRESSED_IMAGE) return null;
  try {
    // Strip UTF-16 surrogate characters (U+D800–U+DFFF) — they appear in some
    // BWC image strings and are illegal in JSON/UTF-8. charCodeAt() is safe
    // here; String.prototype does not throw on surrogates.
    const safe = compressed.split('').filter(c => {
      const cp = c.charCodeAt(0);
      return cp < 0xD800 || cp > 0xDFFF;
    }).join('');

    // Output RGB PNG (colorType 2) — the Qwen3.5 vision tower requires RGB input.
    const png = new PNG({ width: 500, height: 500, colorType: 2, bitDepth: 8 });
    // pngjs RGB: data is [r, g, b, alpha] quads × 500×500
    let px = 0;
    let runIndex = 0;
    for (let i = 0; i < safe.length; i++) {
      const cp = safe.charCodeAt(i);
      const value = runIndex & 1 ? 0 : 255;
      let count = cp - 32;
      while (count-- > 0 && px < png.data.length) {
        png.data[px++] = value; // r
        png.data[px++] = value; // g
        png.data[px++] = value; // b
        png.data[px++] = 255;   // alpha
      }
      runIndex++;
    }
    return PNG.sync.write(png);
  } catch (e: any) {
    console.warn('[moderator-ts] image decompression failed:', e.message);
    return null;
  }
}

// ── Stage 1: Deny-list ───────────────────────────────────────────────────────
// Human-authored hard blocks. Checked first — O(1) lookup, zero latency.
// Use this as a production escape hatch: if a specific card or phrase
// slips through Decider repeatedly, add it here.
//
// Policy: this list is for absolute hard blocks only — content that should
// never appear regardless of game context. The Decider handles everything else.
// Leave empty unless you have a specific confirmed case to block.
// ── Stage 1: Deny list ───────────────────────────────────────────────────────
// Loaded from config.deny_list at startup. O(1) Set lookup.

const DENY_LIST = new Set<string>(config.deny_list.map(s => s.toLowerCase()));

function denyListCheck(title: string): [boolean, string] {
  const t = title.trim().toLowerCase();
  for (const entry of DENY_LIST) {
    if (t === entry || t.startsWith(entry + ' ') || t.endsWith(' ' + entry)) {
      return [true, entry];
    }
  }
  return [false, ''];
}

// ── Stage 2: Spam filter ─────────────────────────────────────────────────────

const REPEAT_RE = /^(.)\1+$/;

// Matches point-value descriptions like "+500 pts", "-100 p", "+0.01 pts.", "500 points"
const POINT_VALUE_RE = /^[+-]?\d+(\.\d+)?\s*(pts?\.?|points?|p)$/i;

function looksLikeGibberish(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  // Exempt point-value strings — "+500 pts" has no vowels but is valid game content
  if (POINT_VALUE_RE.test(t)) return false;
  if (REPEAT_RE.test(t)) return true;
  const hasVowel = /[aeiouAEIOU]/.test(t);
  const hasNonAscii = /[^\x00-\x7F]/.test(t);
  // No vowels + short + ASCII-only = very likely gibberish (pp, bts, Hh, etc.)
  if (!hasVowel && !hasNonAscii && t.length <= 12) return true;
  return false;
}

function spamCheck(title: string, description: string): [boolean, string] {
  /** Return [is_spam, reason]. Only flags when BOTH fields look worthless. */
  const t = title.trim();
  const d = description.trim();
  if (!t && !d) return [true, 'empty'];
  if (t && d && t.toLowerCase() === d.toLowerCase()) {
    if (looksLikeGibberish(t)) return [true, `identical gibberish: ${JSON.stringify(t)}`];
  }
  if (looksLikeGibberish(t) && looksLikeGibberish(d)) {
    return [true, `gibberish title+desc: ${JSON.stringify(t)} / ${JSON.stringify(d)}`];
  }
  return [false, ''];
}

// ── Stage 3: Decider HTTP ────────────────────────────────────────────────────
// Questions loaded from config. Text questions and image questions are sent
// in separate POSTs to prevent image tokens from affecting text calibration.

function buildState(fields: Record<string, string>, template: string): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => fields[key] ?? '');
}

function toDeciderQuestion(q: QuestionConfig): Record<string, unknown> {
  return {
    type: q.type,
    instructions: q.instructions,
    criteria: { hide: q.criteria.hide, ok: q.criteria.ok },
  };
}

// Node's native fetch ignores ALL_PROXY/HTTP_PROXY.
// Use undici EnvHttpProxyAgent which auto-reads ALL_PROXY env var — works with
// Tailscale userspace-networking SOCKS5 proxy at localhost:1055.
let fetchDispatcher: unknown = undefined;
try {
  const { EnvHttpProxyAgent } = await import('undici');
  fetchDispatcher = new EnvHttpProxyAgent();
  const proxy = process.env.ALL_PROXY || process.env.HTTP_PROXY || '(none)';
  console.info(`[moderator-ts] undici EnvHttpProxyAgent ready (ALL_PROXY=${proxy})`);
} catch (e: any) {
  console.warn('[moderator-ts] undici unavailable, using native fetch:', e.message);
}

async function deciderFetch(url: string, init: RequestInit): Promise<Response> {
  if (fetchDispatcher) {
    const { fetch: uFetch } = await import('undici');
    return uFetch(url, { ...init, dispatcher: fetchDispatcher as any } as any) as unknown as Response;
  }
  return fetch(url, init);
}

async function askDecider(
  state: string,
  imageBase64?: string,
): Promise<Record<string, number>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (DECIDER_KEY) headers['Authorization'] = `Bearer ${DECIDER_KEY}`;

  const scores: Record<string, number> = {};

  try {
    // Call 1: text questions (image_only: false) — no image
    const textQuestions = config.questions.filter(q => !q.image_only);
    if (textQuestions.length > 0) {
      const textBody: Record<string, unknown> = {
        model: DECIDER_MODEL,
        state,
        questions: Object.fromEntries(
          textQuestions.map(q => [q.name, toDeciderQuestion(q)])
        ),
      };
      const textResp = await deciderFetch(DECIDER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(textBody),
        signal: AbortSignal.timeout(30_000),
      });
      if (!textResp.ok) throw new Error(`HTTP ${textResp.status}`);
      const textData = await textResp.json() as any;
      for (const q of textQuestions) {
        scores[q.name] = textData.answers?.[q.name]?.probabilities?.hide ?? 0;
      }
    }

    // Call 2: image questions (image_only: true) — only when image present
    const imageQuestions = config.questions.filter(q => q.image_only);
    if (imageBase64 && imageQuestions.length > 0) {
      const imgBody: Record<string, unknown> = {
        model: DECIDER_MODEL,
        state,
        images: [imageBase64],
        questions: Object.fromEntries(
          imageQuestions.map(q => [q.name, toDeciderQuestion(q)])
        ),
      };
      const imgResp = await deciderFetch(DECIDER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(imgBody),
        signal: AbortSignal.timeout(30_000),
      });
      if (imgResp.ok) {
        const imgData = await imgResp.json() as any;
        for (const q of imageQuestions) {
          scores[q.name] = imgData.answers?.[q.name]?.probabilities?.hide ?? 0;
        }
      }
    }
  } catch (e: any) {
    console.warn('[moderator-ts] Decider call failed:', e.message);
  }

  return scores;
}

// ── Stage 4: Nova Lite (Bedrock) ─────────────────────────────────────────────
// Final safety net. Skipped when AWS credentials are unavailable.

async function novaCheck(title: string, description: string): Promise<number> {
  const prompt = (
    'You are a content moderator for an R18+ adult party card game. ' +
    'The game is intentionally crude and offensive — nearly everything is acceptable. ' +
    'This card has passed all automated filters. Decide if it should be HIDDEN.\n\n' +
    `Title: ${title}\n` +
    `Description: ${description}\n\n` +
    'HIDE only if the card contains: a racial/homophobic slur as the title, ' +
    'a genuine personal threat with identifying info, genocidal incitement, ' +
    'sincere self-harm with no game mechanic, or zero game value. ' +
    'Reply with exactly: HIDE: <one sentence reason> or OK: <one sentence reason>'
  );

  try {
    const client = new BedrockRuntimeClient({ region: REGION });
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 60, temperature: 0.0 },
    });
    const resp = await client.send(new InvokeModelCommand({
      modelId: NOVA_MODEL_ID,
      body: Buffer.from(body),
    }));
    const bodyText = new TextDecoder().decode(resp.body);
    const parsed = JSON.parse(bodyText);
    const text: string = parsed.output?.message?.content?.[0]?.text?.trim() ?? '';
    console.info(`[moderator-ts] Nova response: ${text.slice(0, 100)}`);
    return text.toUpperCase().startsWith('HIDE') ? 0.9 : 0.1;
  } catch (e: any) {
    // Gracefully skip when credentials are unavailable or any other error
    if (
      e.name === 'CredentialsProviderError' ||
      e.message?.includes('credential') ||
      e.message?.includes('Could not load credentials')
    ) {
      return 0.0; // skip — no credentials
    }
    console.warn('[moderator-ts] Nova check failed:', e.message);
    return 0.0;
  }
}

// ── Gateway tool calls ────────────────────────────────────────────────────────
// Calls tools on the egress gateway via MCP (SigV4-signed).
// The SDK's GatewayMcpBackend is web-search-specific, so we implement the
// minimal MCP streamable-HTTP subset: initialize → tools/call.

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

let _gatewaySessionId: string | undefined;
let _gatewayInitialized = false;
let _gatewayRequestId = 0;

async function gatewaySend(body: object): Promise<unknown> {
  const credentials = await fromNodeProviderChain()();
  const payload = JSON.stringify(body);
  const url = new URL(EGRESS_GATEWAY_URL);

  const headers: Record<string, string> = {
    'host': url.host,
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26',
  };
  if (_gatewaySessionId) headers['mcp-session-id'] = _gatewaySessionId;

  const req = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    body: payload,
    headers,
  });

  const signer = new SignatureV4({ credentials, region: REGION, service: 'bedrock', sha256: Sha256 });
  const signed = await signer.sign(req);

  const resp = await deciderFetch(EGRESS_GATEWAY_URL, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body: payload,
  });

  // Capture session ID from response
  const sid = (resp.headers as any).get?.('mcp-session-id');
  if (sid) _gatewaySessionId = sid;

  const text = await resp.text();
  // Handle SSE framing
  if (text.startsWith('data:')) {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    return JSON.parse(line!.slice(5).trim());
  }
  return JSON.parse(text);
}

async function gatewayInit(): Promise<void> {
  if (_gatewayInitialized) return;
  _gatewayRequestId++;
  const result = await gatewaySend({
    jsonrpc: '2.0', id: _gatewayRequestId, method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'overseer', version: '1.0' }, capabilities: {} },
  }) as any;
  if (result?.result) {
    _gatewayInitialized = true;
    // Send initialized notification
    await gatewaySend({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
  }
}

async function gatewayCallTool(toolName: string, args: object): Promise<unknown> {
  try {
    await gatewayInit();
    _gatewayRequestId++;
    const result = await gatewaySend({
      jsonrpc: '2.0', id: _gatewayRequestId, method: 'tools/call',
      params: { name: toolName, arguments: args },
    }) as any;
    return result?.result ?? result;
  } catch (e: any) {
    console.warn(`[overseer] Gateway tool call failed (${toolName}):`, e.message);
    return null;
  }
}

// Hide a card via the gateway hide_cards tool
async function hideCard(id: string, reason: string): Promise<void> {
  const result = await gatewayCallTool('hide_cards', { cards: [{ id, reason }] });
  console.info(`[overseer] hide_cards(${id}): ${JSON.stringify(result)}`);
}

// Send an alert via the gateway alert tool
async function sendAlert(severity: string, title: string, detail: string, data?: object): Promise<void> {
  const result = await gatewayCallTool('send_alert', { severity, title, detail, data: data ?? {} });
  console.info(`[overseer] send_alert(${severity}): ${JSON.stringify(result)}`);
}

// ── scoreCard: orchestrate all stages ────────────────────────────────────────

// Generic item — fields map accepts any shape of content.
// The config state_template and image_field determine how fields are used.
interface Item {
  id: string | number;
  fields: Record<string, string>;
}

interface ScoreResult {
  score: number;
  action: string;
  stage: string;
}

async function scoreItem(item: Item): Promise<ScoreResult> {
  const fields = item.fields ?? {};
  const stateStr = buildState(fields, config.state_template);

  if (!stateStr.trim()) return { score: 0.0, action: 'ok', stage: 'empty' };

  // Stage 1 — deny-list: check first field in state_template as the "title"
  const primaryField = (config.state_template.match(/\{(\w+)\}/) ?? [])[1] ?? '';
  const primaryValue = (fields[primaryField] ?? '').trim();
  const [isDenied, matchedEntry] = denyListCheck(primaryValue);
  if (isDenied) {
    console.info(`[overseer] Item ${item.id} stage=deny-list: matched ${JSON.stringify(matchedEntry)}`);
    hideCard(String(item.id), `Deny-list match: ${matchedEntry}`).catch(() => {});
    sendAlert('warning', `Card hidden: ${primaryValue}`, `Deny-list match: ${matchedEntry}`, { id: item.id, stage: 'deny-list' }).catch(() => {});
    return { score: 1.0, action: 'hide', stage: 'deny-list' };
  }

  // Stage 2 — rule-based spam (primary + secondary fields)
  const secondaryField = (config.state_template.match(/\{(\w+)\}.*\{(\w+)\}/) ?? [])[2] ?? '';
  const secondaryValue = (fields[secondaryField] ?? '').trim();
  const [isSpam, spamReason] = spamCheck(primaryValue, secondaryValue);
  if (isSpam) {
    console.info(`[overseer] Item ${item.id} stage=spam: ${spamReason}`);
    hideCard(String(item.id), `Spam filter: ${spamReason}`).catch(() => {});
    sendAlert('warning', `Card hidden: ${primaryValue}`, `Spam filter: ${spamReason}`, { id: item.id, stage: 'spam' }).catch(() => {});
    return { score: 1.0, action: 'hide', stage: 'spam' };
  }

  // Stage 3 — Decider HTTP (questions from config)
  const imageRaw = config.image_field ? (fields[config.image_field] ?? '') : '';
  const imageBuffer = imageRaw ? decompressBwcImage(imageRaw) : null;
  const imageBase64 = imageBuffer ? imageBuffer.toString('base64') : undefined;
  if (imageBase64) {
    console.info(`[overseer] Item ${item.id} including image (${imageBuffer!.length} bytes PNG)`);
  }

  const scores = await askDecider(stateStr, imageBase64);

  for (const q of config.questions) {
    if (q.image_only && !imageBase64) continue;
    const score = scores[q.name] ?? 0;
    if (score >= q.threshold) {
      console.info(`[overseer] Item ${item.id} stage=${q.name}: score=${score.toFixed(4)} — passing to Nova`);
      const novaScore = await novaCheck(primaryValue, secondaryValue);
      if (novaScore >= 0.5) {
        const reason = `Auto-hidden by overseer (stage=llm-hide, score=${novaScore.toFixed(2)})`;
        console.info(`[overseer] Item ${item.id} stage=llm-hide: score=${novaScore}`);
        // Fire-and-forget: hide the card and alert — don't block the response
        hideCard(String(item.id), reason).catch(() => {});
        sendAlert('warning', `Card hidden: ${primaryValue}`, reason, { id: item.id, score: novaScore, stage: 'llm-hide' }).catch(() => {});
        return { score: novaScore, action: 'hide', stage: 'llm-hide' };
      }
      return { score, action: q.action, stage: q.name };
    }
  }

  // All passed — skip Nova
  const topScore = scores[config.questions.find(q => !q.image_only)?.name ?? ''] ?? 0;
  const scoreStr = Object.entries(scores).map(([k, v]) => `${k}=${v.toFixed(4)}`).join(' ');
  console.info(`[overseer] Item ${item.id} stage=ok: ${scoreStr}`);
  return { score: topScore, action: 'ok', stage: 'ok' };
}

// ── BedrockAgentCoreApp entrypoint ────────────────────────────────────────────

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload: any) => {
      try {
        console.info(`[moderator-ts] Raw payload type=${typeof payload}: ${String(payload).slice(0, 200)}`);

        // Normalise payload — same logic as Python invoke()
        let opts: Record<string, any> = payload && typeof payload === 'object' ? payload : {};

        if (typeof payload === 'string') {
          try {
            opts = JSON.parse(payload);
          } catch (e: any) {
            opts = { prompt: payload };
          }
        }

        // Handle nested JSON in the "prompt" field (AgentCore wraps payloads)
        if (typeof opts.prompt === 'string' && opts.prompt.startsWith('{')) {
          try {
            const nested = JSON.parse(opts.prompt);
            if (nested && typeof nested === 'object') {
              opts = { ...opts, ...nested };
            }
          } catch (e: any) {
            // not JSON — leave as is
          }
        }

        // Accept both generic items[] and legacy cards[] for BWC compatibility
        const items: Item[] = opts.items ?? (opts.cards ?? []).map((c: any) => ({
          id: c.id,
          fields: {
            title: c.title ?? '',
            description: c.description ?? '',
            image: c.image ?? '',
          },
        }));

        if (!items.length) {
          console.info('[overseer] Empty batch — nothing to score');
          return JSON.stringify({ results: [], message: 'No items to review.' });
        }

        console.info(`[overseer] Scoring ${items.length} items (model=${DECIDER_MODEL})`);

        const results: Array<{ id: string | number; score: number; action: string; stage: string }> = [];
        for (const item of items) {
          const { score, action, stage } = await scoreItem(item);
          results.push({ id: item.id, score, action, stage });
          console.info(
            `[overseer] Item ${item.id} scored score=${score.toFixed(4)} action=${action} stage=${stage}`
          );
        }

        console.info(`[overseer] Invocation complete — scored ${results.length} items`);
        return JSON.stringify({ results });
      } catch (e: any) {
        console.error('[moderator-ts] Handler error:', e.message, e.stack);
        return JSON.stringify({ error: e.message });
      }
    },
  },
  config: {
    contentTypeParsers: [{
      contentType: '*',
      parseAs: 'string',
      parser: (_req: any, body: any, done: any) => {
        try { done(null, body ? JSON.parse(body) : {}); } catch (e: any) { done(null, body); }
      },
    }],
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
