import { useEffect, useRef, useState } from 'react';
import {
  CompareError,
  DEFAULT_SETTINGS,
  testConnection,
  type ConnectionReport,
  type Settings,
} from '../lib/api';

interface SettingsPanelProps {
  open: boolean;
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'done'; report: ConnectionReport }
  | { status: 'failed'; message: string; providerBody?: string };

export function SettingsPanel({ open, settings, onChange, onClose }: SettingsPanelProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [revealKey, setRevealKey] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  // A result only describes the settings it was run against, so any edit clears it.
  useEffect(() => {
    setTest({ status: 'idle' });
  }, [draft.baseUrl, draft.apiKey, draft.modelA, draft.modelB, draft.disableReasoning]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const normalise = (value: Settings): Settings => ({
    ...value,
    baseUrl: value.baseUrl.trim(),
    apiKey: value.apiKey.trim(),
    modelA: value.modelA.trim(),
    modelB: value.modelB.trim(),
    temperature: Number.isFinite(value.temperature) ? value.temperature : 0,
    maxTokens: Number.isFinite(value.maxTokens) && value.maxTokens > 0 ? Math.floor(value.maxTokens) : 1600,
  });

  const save = () => {
    onChange(normalise(draft));
    onClose();
  };

  const runTest = async () => {
    setTest({ status: 'testing' });
    try {
      const report = await testConnection(normalise(draft));
      setTest({ status: 'done', report });
    } catch (cause) {
      const failure =
        cause instanceof CompareError
          ? cause
          : new CompareError({ message: cause instanceof Error ? cause.message : String(cause) });
      setTest({ status: 'failed', message: failure.detail.message, providerBody: failure.detail.providerBody });
    }
  };

  return (
    <div className="settings-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings__head">
          <div>
            <p className="eyebrow">Connection</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <div className="settings__body">
          <label className="field">
            <span className="field__label">Base URL</span>
            <input
              ref={firstFieldRef}
              className="input"
              type="url"
              spellCheck={false}
              autoComplete="off"
              value={draft.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
              placeholder={DEFAULT_SETTINGS.baseUrl}
            />
            <span className="field__hint">Any OpenAI-compatible endpoint. <code>/chat/completions</code> is appended.</span>
          </label>

          <label className="field">
            <span className="field__label">API key</span>
            <span className="field__row">
              <input
                className="input"
                type={revealKey ? 'text' : 'password'}
                spellCheck={false}
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => update('apiKey', e.target.value)}
                placeholder="sk-..."
              />
              <button type="button" className="btn btn--ghost" onClick={() => setRevealKey((v) => !v)}>
                {revealKey ? 'Hide' : 'Show'}
              </button>
            </span>
            <span className="field__hint">
              Stored in this browser's localStorage and sent only to your own server on port 3001. Never bundled into the app.
            </span>
          </label>

          <div className="settings__grid">
            <label className="field">
              <span className="field__label">
                Model A <span className="field__tag field__tag--a">older</span>
              </span>
              <input
                className="input input--mono"
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={draft.modelA}
                onChange={(e) => update('modelA', e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">
                Model B <span className="field__tag field__tag--b">newer</span>
              </span>
              <input
                className="input input--mono"
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={draft.modelB}
                onChange={(e) => update('modelB', e.target.value)}
              />
            </label>
          </div>

          <div className="settings__grid">
            <label className="field">
              <span className="field__label">Temperature</span>
              <input
                className="input input--mono"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(e) => update('temperature', Number(e.target.value))}
              />
              <span className="field__hint">0 makes a repeat run reproducible.</span>
            </label>

            <label className="field">
              <span className="field__label">Max tokens</span>
              <input
                className="input input--mono"
                type="number"
                min={16}
                max={32000}
                step={16}
                value={draft.maxTokens}
                onChange={(e) => update('maxTokens', Number(e.target.value))}
              />
              <span className="field__hint">Doubled automatically once if an answer comes back empty.</span>
            </label>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={draft.disableReasoning}
              onChange={(e) => update('disableReasoning', e.target.checked)}
            />
            <span>
              <strong>Disable reasoning</strong>
              <span className="check__hint">
                Sends <code>chat_template_kwargs: {'{"enable_thinking": false}'}</code> so both models answer directly.
              </span>
            </span>
          </label>
        </div>

        <section className="conntest" aria-live="polite">
          <div className="conntest__head">
            <div>
              <h3 className="conntest__title">Test connection</h3>
              <p className="conntest__note">
                Sends one tiny request to each model, so you know the key and both model names work
                before running a comparison.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--test"
              onClick={() => void runTest()}
              disabled={test.status === 'testing' || draft.apiKey.trim().length === 0}
            >
              {test.status === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
          </div>

          {draft.apiKey.trim().length === 0 ? (
            <p className="conntest__hint">Enter an API key to enable the test.</p>
          ) : null}

          {test.status === 'failed' ? (
            <div className="conntest__result conntest__result--bad">
              <p className="conntest__verdict">Could not run the test</p>
              <p className="conntest__message">{test.message}</p>
              {test.providerBody ? <pre className="conntest__body">{test.providerBody}</pre> : null}
            </div>
          ) : null}

          {test.status === 'done' ? (
            <div className={`conntest__result conntest__result--${test.report.ok ? 'good' : 'bad'}`}>
              <p className="conntest__verdict">
                {test.report.ok
                  ? 'Both models answered. You are ready to run the test.'
                  : 'One or both models failed. Fix the problem below, then test again.'}
              </p>

              {/* The most important thing this panel can tell you: if both names resolve
                  to one model, the comparison is that model against itself, so an
                  IDENTICAL verdict would mean nothing. */}
              {test.report.sameModelId ? (
                <div className="collide" role="alert">
                  <p className="collide__title">Both names resolve to the same model</p>
                  <p className="collide__body">
                    This endpoint serves <code>{test.report.a.servedModel}</code> for both model
                    names. A comparison would be that model against itself, so it would report
                    IDENTICAL no matter what you ask — that result would be routing, not a
                    finding. Use two names that resolve to different ids.
                  </p>
                </div>
              ) : null}

              <div className="conntest__grid">
                {[test.report.a, test.report.b].map((probe) => (
                  <article
                    key={probe.slot}
                    className={`probe probe--${probe.ok ? 'ok' : 'bad'} probe--${probe.slot.toLowerCase()}`}
                  >
                    <header className="probe__head">
                      <span className="probe__slot">{probe.slot}</span>
                      <span className="probe__status">{probe.ok ? 'OK' : 'FAILED'}</span>
                    </header>

                    {probe.ok && probe.aliased ? (
                      <>
                        <p className="probe__alias-label">asked for</p>
                        <p className="probe__model probe__model--muted" title={probe.requestedModel}>
                          {probe.requestedModel}
                        </p>
                        <p className="probe__alias-label">served</p>
                        <p className="probe__model" title={probe.servedModel ?? undefined}>
                          {probe.servedModel}
                        </p>
                      </>
                    ) : (
                      <p className="probe__model" title={probe.requestedModel}>
                        {probe.requestedModel}
                      </p>
                    )}

                    {probe.ok ? (
                      <>
                        <dl className="probe__stats">
                          <div>
                            <dt>Latency</dt>
                            <dd>{probe.latencyMs} ms</dd>
                          </div>
                          <div>
                            <dt>Reasoning</dt>
                            <dd>{probe.reasoningTokens.toLocaleString()}</dd>
                          </div>
                        </dl>
                        <p className="probe__sample">replied: “{probe.sample}”</p>
                        {probe.aliased ? (
                          <p className="probe__note">the provider routed this name elsewhere</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="probe__error">{probe.error?.message}</p>
                        {probe.error?.providerBody ? (
                          <pre className="probe__body">{probe.error.providerBody}</pre>
                        ) : null}
                      </>
                    )}
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <footer className="settings__foot">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setDraft({ ...DEFAULT_SETTINGS, apiKey: draft.apiKey })}
          >
            Reset to defaults
          </button>
          <button type="button" className="btn btn--primary" onClick={save}>
            Save settings
          </button>
        </footer>
      </section>
    </div>
  );
}