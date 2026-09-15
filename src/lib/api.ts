import type { CompareResponse, ModelCallResult } from '../../server/types';

export type { CompareResponse, ModelCallResult, ModelSlot } from '../../server/types';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  modelA: string;
  modelB: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  modelA: 'deepseek-v4-flash-0731',
  modelB: 'deepseek-v4.1-flash',
  temperature: 0,
  maxTokens: 1600,
  disableReasoning: true,
};

const STORAGE_KEY = 'identical-twins-test.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_SETTINGS.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_SETTINGS.apiKey,
      modelA: typeof parsed.modelA === 'string' ? parsed.modelA : DEFAULT_SETTINGS.modelA,
      modelB: typeof parsed.modelB === 'string' ? parsed.modelB : DEFAULT_SETTINGS.modelB,
      temperature: Number.isFinite(parsed.temperature) ? Number(parsed.temperature) : DEFAULT_SETTINGS.temperature,
      maxTokens: Number.isFinite(parsed.maxTokens) ? Number(parsed.maxTokens) : DEFAULT_SETTINGS.maxTokens,
      disableReasoning:
        typeof parsed.disableReasoning === 'boolean' ? parsed.disableReasoning : DEFAULT_SETTINGS.disableReasoning,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, quota). Settings stay in memory.
  }
}

export interface ApiFailure {
  message: string;
  providerBody?: string;
  status?: number;
  slot?: 'A' | 'B';
}

export class CompareError extends Error {
  readonly detail: ApiFailure;

  constructor(detail: ApiFailure) {
    super(detail.message);
    this.name = 'CompareError';
    this.detail = detail;
  }
}

export async function comparePrompt(prompt: string, settings: Settings): Promise<CompareResponse> {
  let response: Response;
  try {
    response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, settings }),
    });
  } catch (cause) {
    throw new CompareError({
      message: `Could not reach the local API server on port 3001. Is \`npm run dev\` still running? (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    });
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CompareError({
      message: `The API server returned a non-JSON response (HTTP ${response.status}).`,
      providerBody: text.slice(0, 2000),
    });
  }

  if (!response.ok) {
    const error = (payload as { error?: ApiFailure }).error;
    throw new CompareError({
      message: error?.message ?? `Request failed with HTTP ${response.status}.`,
      providerBody: error?.providerBody,
      status: error?.status ?? response.status,
      slot: error?.slot,
    });
  }

  return payload as CompareResponse;
}

export interface ConnectionProbe {
  slot: 'A' | 'B';
  /** The model name that was asked for. */
  requestedModel: string;
  ok: boolean;
  latencyMs: number;
  /** The model id the provider reported serving. */
  servedModel: string | null;
  /** True when the provider served a different model than the one requested. */
  aliased: boolean;
  sample: string | null;
  reasoningTokens: number;
  error: { message: string; providerBody?: string; status?: number } | null;
}

export interface ConnectionReport {
  ok: boolean;
  baseUrl: string;
  /**
   * True when both names resolved to the same served model, which means a comparison
   * would be that model against itself.
   */
  sameModelId: boolean;
  a: ConnectionProbe;
  b: ConnectionProbe;
}

/**
 * Probes the configured endpoint and both models. Resolves with a report rather
 * than throwing for a failed probe, because "this model name is wrong" is a result
 * the settings panel needs to display, not an error to crash on.
 */
export async function testConnection(settings: Settings): Promise<ConnectionReport> {
  let response: Response;
  try {
    response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
  } catch (cause) {
    throw new CompareError({
      message: `Could not reach the local API server on port 3001. Is \`npm run dev\` still running? (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    });
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CompareError({
      message: `The API server returned a non-JSON response (HTTP ${response.status}).`,
      providerBody: text.slice(0, 2000),
    });
  }

  if (!response.ok) {
    const error = (payload as { error?: ApiFailure }).error;
    throw new CompareError({
      message: error?.message ?? `Test failed with HTTP ${response.status}.`,
      providerBody: error?.providerBody,
      status: error?.status ?? response.status,
    });
  }

  return payload as ConnectionReport;
}

export interface RunRecord {
  id: string;
  prompt: string;
  identical: boolean;
  a: ModelCallResult;
  b: ModelCallResult;
  createdAt: string;
  /** Full server response, kept so "Copy run as JSON" is lossless. */
  raw: CompareResponse;
}

export function toRunRecord(response: CompareResponse): RunRecord {
  return {
    id: response.runId,
    prompt: response.prompt,
    identical: response.identical,
    a: response.a,
    b: response.b,
    createdAt: response.createdAt,
    raw: response,
  };
}

/** Estimates token count client-side for the readout. The authoritative count is usage. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // Rough heuristic: ~4 characters per token for English prose.
  return Math.max(1, Math.round(text.length / 4));
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function shortHash(hash: string, length = 10): string {
  return hash.slice(0, length);
}