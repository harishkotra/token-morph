import type { ModelCallResult } from '../lib/api';
import { formatMs, shortHash } from '../lib/api';

interface ModelColumnProps {
  slot: 'A' | 'B';
  role: string;
  result: ModelCallResult | null;
  pending: boolean;
}

export function ModelColumn({ slot, role, result, pending }: ModelColumnProps) {
  const accent = slot === 'A' ? 'var(--a)' : 'var(--b)';

  return (
    <article className={`model model--${slot.toLowerCase()}`} style={{ '--accent': accent } as React.CSSProperties}>
      <header className="model__head">
        <span className="model__slot">{slot}</span>
        <span className="model__role">{role}</span>
      </header>

      <p className="model__name" title={result?.servedModel ?? undefined}>
        {result?.servedModel ?? '—'}
      </p>

      {result?.aliased ? (
        <p className="model__alias" title={`Requested ${result.requestedModel}`}>
          asked for <code>{result.requestedModel}</code>
        </p>
      ) : null}

      <dl className="model__stats">
        <div>
          <dt>Latency</dt>
          <dd>{result ? formatMs(result.latencyMs) : pending ? '…' : '—'}</dd>
        </div>
        <div>
          <dt>Completion</dt>
          <dd>{result ? result.completionTokens.toLocaleString() : pending ? '…' : '—'}</dd>
        </div>
        <div>
          <dt>Prompt</dt>
          <dd>{result ? result.promptTokens.toLocaleString() : pending ? '…' : '—'}</dd>
        </div>
        <div>
          <dt>Reasoning</dt>
          <dd className={result && result.reasoningTokens > 0 ? 'model__reasoning' : undefined}>
            {result ? result.reasoningTokens.toLocaleString() : pending ? '…' : '—'}
          </dd>
        </div>
      </dl>

      <div className="model__hash">
        <span className="model__hash-label">sha256</span>
        <code className="model__hash-value">{result ? shortHash(result.sha256, 16) : '—'}</code>
      </div>

      {result?.retried ? (
        <p className="model__note">
          First attempt returned no content; retried with a {result.attempts === 2 ? 'doubled' : ''} budget.
        </p>
      ) : null}
    </article>
  );
}