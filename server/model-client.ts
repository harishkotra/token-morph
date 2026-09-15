import { sha256 } from './hash.ts';
import type { ModelCallRequest, ModelCallResult, ModelSlot } from './types.ts';

/** A failure that carries the provider's own words so the UI can show them verbatim. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly providerBody?: string;
  readonly slot?: ModelSlot;

  constructor(message: string, opts: { status?: number; providerBody?: string; slot?: ModelSlot } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.providerBody = opts.providerBody;
    this.slot = opts.slot;
  }
}

const REQUEST_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 30_000;

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
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/**
 * Pull the assistant text out of a chat completion.
 *
 * Note what is missing: `message.reasoning_content` is never touched. Some
 * OpenAI-compatible servers return it alongside `content`; we ignore it entirely
 * so that chain-of-thought can never reach a log, a response body, or the DOM.
 */
function extractContent(payload: ChatCompletionResponse): string {
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw === 'string') return raw;
  // Some servers return content as an array of parts. Join the text parts only.
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

interface AttemptOutcome {
  content: string;
  model: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

async function callOnce(req: ModelCallRequest, maxTokens: number): Promise<AttemptOutcome> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userPrompt },
    ],
    temperature: req.temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  if (req.disableReasoning) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  let response: Response;
  try {
    response = await fetch(joinUrl(req.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ProviderError(`Could not reach ${req.baseUrl}: ${message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    // Surface the provider's real error text, not a paraphrase of it.
    throw new ProviderError(
      `Provider returned HTTP ${response.status} ${response.statusText}`,
      { status: response.status, providerBody: text.slice(0, 4000) },
    );
  }

  let payload: ChatCompletionResponse;
  try {
    payload = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new ProviderError('Provider returned a response that is not JSON', {
      status: response.status,
      providerBody: text.slice(0, 4000),
    });
  }

  if (payload.choices === undefined) {
    throw new ProviderError('Provider response contained no choices', {
      status: response.status,
      providerBody: text.slice(0, 4000),
    });
  }

  return {
    content: extractContent(payload),
    model: payload.model ?? req.model,
    finishReason: payload.choices[0]?.finish_reason ?? null,
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    // Acceptance criterion 3: the count comes from the usage block, nothing else.
    reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Call one model, retrying once with a doubled token budget if the content came
 * back empty (a reasoning model can spend the whole budget thinking and emit no
 * answer at all, which is not a real comparison).
 */
export async function callModel(slot: ModelSlot, req: ModelCallRequest): Promise<ModelCallResult> {
  const startedAt = Date.now();
  let attempts = 0;
  let outcome: AttemptOutcome;

  try {
    attempts += 1;
    outcome = await callOnce(req, req.maxTokens);

    if (outcome.content.length === 0) {
      attempts += 1;
      outcome = await callOnce(req, req.maxTokens * 2);
    }
  } catch (cause) {
    if (cause instanceof ProviderError) {
      throw new ProviderError(cause.message, {
        status: cause.status,
        providerBody: cause.providerBody,
        slot,
      });
    }
    throw cause;
  }

  const latencyMs = Date.now() - startedAt;

  return {
    slot,
    requestedModel: req.model,
    servedModel: outcome.model,
    aliased: outcome.model !== req.model,
    content: outcome.content,
    sha256: sha256(outcome.content),
    latencyMs,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    reasoningTokens: outcome.reasoningTokens,
    retried: attempts > 1,
    attempts,
    finishReason: outcome.finishReason,
  };
}

/** The outcome of one model probe, reported back to the settings panel. */
export interface ConnectionProbe {
  slot: ModelSlot;
  /** The model name that was asked for. */
  requestedModel: string;
  ok: boolean;
  /** How long the probe took. */
  latencyMs: number;
  /** The model id the provider reported serving, when it answered at all. */
  servedModel: string | null;
  /** True when the provider served a different model than the one requested. */
  aliased: boolean;
  /** A short sample of the reply, so the user can see it really answered. */
  sample: string | null;
  reasoningTokens: number;
  error: {
    message: string;
    providerBody?: string;
    status?: number;
  } | null;
}

/**
 * Probes one model with a minimal request, to answer "does this key and model
 * actually work?" before the user runs a real comparison.
 *
 * The request is deliberately tiny: one short user message and a small token
 * budget, so testing costs almost nothing. A 404 or "model not found" is reported
 * as a model problem rather than an auth problem, because those need different
 * fixes and conflating them wastes the user's time.
 */
export async function testModel(slot: ModelSlot, req: ModelCallRequest): Promise<ConnectionProbe> {
  const startedAt = Date.now();

  try {
    const response = await fetch(joinUrl(req.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: 'system', content: 'You are a precise assistant. Answer the user\'s request directly.' },
          { role: 'user', content: 'Reply with the single word: ready' },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false,
        ...(req.disableReasoning ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        slot,
        requestedModel: req.model,
        ok: false,
        latencyMs: Date.now() - startedAt,
        servedModel: null,
        aliased: false,
        sample: null,
        reasoningTokens: 0,
        error: {
          message: describeHttpFailure(response.status, text, req.model),
          providerBody: text.slice(0, 2000),
          status: response.status,
        },
      };
    }

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      return {
        slot,
        requestedModel: req.model,
        ok: false,
        latencyMs: Date.now() - startedAt,
        servedModel: null,
        aliased: false,
        sample: null,
        reasoningTokens: 0,
        error: { message: 'The provider replied with something that is not JSON.', providerBody: text.slice(0, 2000) },
      };
    }

    const content = extractContent(payload);
    const servedModel = payload.model ?? req.model;

    // A 200 with no choices is not a working endpoint.
    if (payload.choices === undefined) {
      return {
        slot,
        requestedModel: req.model,
        ok: false,
        latencyMs: Date.now() - startedAt,
        servedModel,
        aliased: servedModel !== req.model,
        sample: null,
        reasoningTokens: 0,
        error: { message: 'The provider accepted the request but returned no choices.', providerBody: text.slice(0, 2000) },
      };
    }

    return {
      slot,
      requestedModel: req.model,
      ok: true,
      latencyMs: Date.now() - startedAt,
      servedModel,
      aliased: servedModel !== req.model,
      sample: content.trim().slice(0, 120) || '(empty reply)',
      reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      error: null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const timedOut = message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted');
    return {
      slot,
      requestedModel: req.model,
      ok: false,
      latencyMs: Date.now() - startedAt,
      servedModel: null,
      aliased: false,
      sample: null,
      reasoningTokens: 0,
      error: {
        message: timedOut
          ? `No response within ${TEST_TIMEOUT_MS / 1000}s. The base URL may be wrong or unreachable.`
          : `Could not reach ${req.baseUrl}: ${message}`,
      },
    };
  }
}

/** Turns an HTTP failure into a message that names the likely cause. */
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
  if (status >= 500) {
    return `The provider returned a server error (HTTP ${status}). This is usually temporary.`;
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist') || lower.includes('unknown'))) {
    return `The provider does not recognise the model "${model}". Check the model name.`;
  }
  return `The provider refused the request (HTTP ${status}).`;
}