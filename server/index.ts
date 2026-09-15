import express from 'express';
import { newNonce, newRunId, sha256 } from './hash.ts';
import { ProviderError, callModel, testModel } from './model-client.ts';
import type { ApiErrorBody, CompareRequest, CompareResponse } from './types.ts';

export const SYSTEM_PROMPT = "You are a precise assistant. Answer the user's request directly.";

const DEFAULT_BASE_URL = 'https://api.particle.ai/v1';
const DEFAULT_MODEL_A = 'deepseek-v4-flash-0731';
const DEFAULT_MODEL_B = 'deepseek-v4.1-flash';
const DEFAULT_MAX_TOKENS = 1600;

const MAX_PROMPT_CHARS = 8000;

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'the-identical-twins-test' });
});

app.post('/api/compare', async (req, res) => {
  const body = req.body as Partial<CompareRequest> | undefined;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';

  if (prompt.length === 0) {
    res.status(400).json({ error: { message: 'Send a prompt to compare.' } } satisfies ApiErrorBody);
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({
      error: { message: `Prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.` },
    } satisfies ApiErrorBody);
    return;
  }

  const s = body?.settings;
  const baseUrl = (s?.baseUrl || DEFAULT_BASE_URL).trim();
  const apiKey = (s?.apiKey || '').trim();
  const modelA = (s?.modelA || DEFAULT_MODEL_A).trim();
  const modelB = (s?.modelB || DEFAULT_MODEL_B).trim();
  const temperature = Number.isFinite(s?.temperature) ? Number(s?.temperature) : 0;
  const maxTokens =
    Number.isFinite(s?.maxTokens) && Number(s?.maxTokens) > 0 ? Math.floor(Number(s?.maxTokens)) : DEFAULT_MAX_TOKENS;
  const disableReasoning = s?.disableReasoning === true;

  if (apiKey.length === 0) {
    res.status(400).json({
      error: { message: 'No API key set. Open Settings and paste your provider key.' },
    } satisfies ApiErrorBody);
    return;
  }
  if (modelA.length === 0 || modelB.length === 0) {
    res.status(400).json({ error: { message: 'Both model names are required.' } } satisfies ApiErrorBody);
    return;
  }

  // A fresh nonce every call means a provider-side cache can never hand us the
  // same bytes twice and fake an IDENTICAL verdict.
  const nonce = typeof body?.nonce === 'string' && body.nonce.length > 0 ? body.nonce : newNonce();
  const wirePrompt = `${prompt}\n\n${nonce}`;

  const shared = {
    baseUrl,
    apiKey,
    temperature,
    maxTokens,
    disableReasoning,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: wirePrompt,
  };

  try {
    // Both models are called concurrently with the identical user message.
    const [a, b] = await Promise.all([
      callModel('A', { ...shared, model: modelA }),
      callModel('B', { ...shared, model: modelB }),
    ]);

    // Acceptance criterion 1: the verdict is a comparison of the real sha256
    // digests of the two response bodies, computed here from the actual bytes.
    const hashEqual = a.sha256 === b.sha256;

    // Providers may route an old model name to a new model. When both slots are served
    // the same id, this comparison was the same model twice, and an IDENTICAL verdict
    // is explained by that routing rather than by the two models agreeing. Recording it
    // here keeps the finding honest instead of letting it read as a discovery.
    const sameModelId = a.servedModel === b.servedModel;
    const anyAliased = a.aliased || b.aliased;

    const response: CompareResponse = {
      runId: newRunId(),
      prompt,
      wirePrompt,
      nonce,
      identical: hashEqual,
      hashEqual,
      sameModelId,
      anyAliased,
      a,
      b,
      createdAt: new Date().toISOString(),
    };

    // Server-side receipt of the finding. Content is never logged.
    console.log(
      `[compare] ${response.runId} ${hashEqual ? 'IDENTICAL' : 'DIVERGED'} ` +
        `A=${a.servedModel} ${a.sha256.slice(0, 12)} ${a.latencyMs}ms | ` +
        `B=${b.servedModel} ${b.sha256.slice(0, 12)} ${b.latencyMs}ms` +
        (sameModelId ? ' | SAME-MODEL: both slots served one model' : '') +
        (anyAliased && !sameModelId ? ' | ALIASED' : ''),
    );

    res.json(response);
  } catch (cause) {
    if (cause instanceof ProviderError) {
      console.error(`[compare] provider error on model ${cause.slot ?? '?'}: ${cause.message}`);
      res.status(502).json({
        error: {
          message: cause.message,
          providerBody: cause.providerBody,
          status: cause.status,
          slot: cause.slot,
        },
      } satisfies ApiErrorBody);
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[compare] unexpected error: ${message}`);
    res.status(500).json({ error: { message } } satisfies ApiErrorBody);
  }
});

/**
 * Probes both models with a minimal request so the user can confirm their key, base
 * URL, and model names work before running a real comparison.
 *
 * Always answers 200 with a per-model report: a failed probe is a result, not a
 * server error, and the settings panel needs both outcomes side by side.
 */
app.post('/api/test-connection', async (req, res) => {
  const body = req.body as Partial<CompareRequest> | undefined;
  const s = body?.settings;

  const baseUrl = (s?.baseUrl || DEFAULT_BASE_URL).trim();
  const apiKey = (s?.apiKey || '').trim();
  const modelA = (s?.modelA || DEFAULT_MODEL_A).trim();
  const modelB = (s?.modelB || DEFAULT_MODEL_B).trim();
  const disableReasoning = s?.disableReasoning === true;

  if (apiKey.length === 0) {
    res.status(400).json({
      error: { message: 'Enter an API key first, then test the connection.' },
    } satisfies ApiErrorBody);
    return;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    res.status(400).json({
      error: { message: `The base URL must start with http:// or https:// — got "${baseUrl}".` },
    } satisfies ApiErrorBody);
    return;
  }

  const shared = { baseUrl, apiKey, temperature: 0, maxTokens: 16, disableReasoning, systemPrompt: '', userPrompt: '' };

  const [a, b] = await Promise.all([
    testModel('A', { ...shared, model: modelA }),
    testModel('B', { ...shared, model: modelB }),
  ]);

  // If both names resolve to one model, the comparison would be that model against
  // itself. Worth saying out loud before the user runs it, not after.
  const sameModelId =
    a.ok && b.ok && a.servedModel !== null && a.servedModel === b.servedModel;

  console.log(
    `[test-connection] ${baseUrl} A=${modelA}→${a.servedModel ?? '—'} ${a.ok ? 'ok' : 'FAILED'} | ` +
      `B=${modelB}→${b.servedModel ?? '—'} ${b.ok ? 'ok' : 'FAILED'}` +
      (sameModelId ? ' | SAME-MODEL' : ''),
  );

  res.json({ ok: a.ok && b.ok, baseUrl, sameModelId, a, b });
});

/**
 * Echoes the sha256 of a supplied string, so a digest can be checked independently.
 */
app.post('/api/digest', (req, res) => {
  const text = typeof (req.body as { text?: unknown } | undefined)?.text === 'string'
    ? (req.body as { text: string }).text
    : '';
  res.json({ sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') });
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`[server] The Identical Twins Test API listening on http://localhost:${PORT}`);
});