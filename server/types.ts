/**
 * Shared wire types between the server and the browser.
 *
 * `reasoning_content` is deliberately absent from every type in this file: the
 * provider's chain-of-thought is never transported, stored, or rendered. Only its
 * token count crosses the wire.
 */

export type ModelSlot = 'A' | 'B';

export interface ModelCallRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
  systemPrompt: string;
  userPrompt: string;
}

export interface ModelCallResult {
  slot: ModelSlot;
  /** The model name that was asked for. */
  requestedModel: string;
  /**
   * The model id the provider reported actually serving. Providers are free to route
   * an old name to a new model, so this can differ from `requestedModel` — and when it
   * does, a comparison between the two slots may be the same model twice.
   */
  servedModel: string;
  /** True when the provider served something other than the name that was requested. */
  aliased: boolean;
  content: string;
  sha256: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  /** From usage.completion_tokens_details.reasoning_tokens. Never the text itself. */
  reasoningTokens: number;
  /** True when the first attempt returned empty content and the retry produced this. */
  retried: boolean;
  /** Number of attempts made, 1 or 2. */
  attempts: number;
  finishReason: string | null;
}

export interface CompareRequest {
  prompt: string;
  /** Appended to the user prompt on the wire so a response cache cannot fake a verdict. */
  nonce?: string;
  settings: {
    baseUrl: string;
    apiKey: string;
    modelA: string;
    modelB: string;
    temperature: number;
    maxTokens: number;
    disableReasoning: boolean;
  };
}

export interface CompareResponse {
  runId: string;
  prompt: string;
  /** The exact user message sent to both models, nonce included. */
  wirePrompt: string;
  nonce: string;
  identical: boolean;
  /** Server-side sha256 comparison of the two response bodies. */
  hashEqual: boolean;
  /**
   * True when both slots reported the same served model id. When this is true the
   * comparison was the same model twice, so an IDENTICAL verdict is explained by
   * routing rather than by the two models agreeing.
   */
  sameModelId: boolean;
  /** True when either slot was served a model other than the one requested. */
  anyAliased: boolean;
  a: ModelCallResult;
  b: ModelCallResult;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
    /** Raw provider text, verbatim, when the failure came from upstream. */
    providerBody?: string;
    status?: number;
    slot?: ModelSlot;
  };
}