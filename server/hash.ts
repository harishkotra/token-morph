import { createHash, randomUUID } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newRunId(): string {
  return randomUUID();
}

/**
 * Short, human-readable nonce appended to the user prompt so that a provider-side
 * response cache cannot manufacture an IDENTICAL verdict for a prompt we already
 * sent. Without it, a cache would make two genuinely different models look equal.
 */
export function newNonce(): string {
  return `[nonce ${randomUUID().slice(0, 8)}]`;
}