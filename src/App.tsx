import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffStrip } from './components/DiffStrip';
import { ModelColumn } from './components/ModelColumn';
import { RunHistory } from './components/RunHistory';
import { SettingsPanel } from './components/SettingsPanel';
import {
  CompareError,
  comparePrompt,
  formatMs,
  loadSettings,
  saveSettings,
  shortHash,
  toRunRecord,
  type CompareResponse,
  type RunRecord,
  type Settings,
} from './lib/api';
import { ParticleScene, type Phase, type SceneStats } from './lib/particles';
import { PRESET_GROUPS } from './lib/presets';
import { sampleTextToParticles } from './lib/sampler';

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Idle',
  calling: 'Calling both models',
  'laying-out': 'Laying out A',
  morphing: 'Morphing A → B',
  identical: 'Locked · identical',
  error: 'Error',
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ParticleScene | null>(null);

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState(PRESET_GROUPS[0].presets[0].prompt);
  const [phase, setPhase] = useState<Phase>('idle');
  const [run, setRun] = useState<CompareResponse | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<CompareError | null>(null);
  const [stats, setStats] = useState<SceneStats>({ phase: 'idle', movedParticles: 0, maxDisplacement: 0, fps: 60 });
  const [copied, setCopied] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);

  const runTokenRef = useRef(0);
  const hydratedRef = useRef(false);

  useEffect(() => {
    // Skip the first run: settings were just read from storage, so writing them
    // straight back would clobber anything a newer version stored alongside them.
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    saveSettings(settings);
  }, [settings]);

  // Boot the three.js scene once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new ParticleScene(canvas);
    sceneRef.current = scene;
    setSceneReady(true);

    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);

    const poll = window.setInterval(() => setStats(scene.getStats()), 180);

    return () => {
      window.clearInterval(poll);
      window.removeEventListener('resize', onResize);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const runComparison = useCallback(async () => {
    const scene = sceneRef.current;
    const trimmed = prompt.trim();
    if (!scene || trimmed.length === 0) return;

    const token = runTokenRef.current + 1;
    runTokenRef.current = token;

    setError(null);
    setRun(null);
    setCopied(false);
    setPhase('calling');
    scene.setPhase('calling');
    scene.resetCamera();
    // On a narrow screen the console sits below the canvas, so a click on "Run"
    // would otherwise scroll the verdict out of sight.
    stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const response = await comparePrompt(trimmed, settings);
      if (runTokenRef.current !== token) return;

      setRun(response);

      // Phase 1: lay out Model A's answer as particles.
      setPhase('laying-out');
      scene.setPhase('laying-out');
      const layoutA = sampleTextToParticles(response.a.content);
      scene.setLayoutA(layoutA);

      const record = toRunRecord(response);
      setRuns((prev) => [...prev, record]);

      if (response.identical) {
        // Byte-identical: skip the morph entirely and lock the cloud in place.
        window.setTimeout(() => {
          if (runTokenRef.current !== token) return;
          scene.lock();
          setPhase('identical');
        }, 900);
      } else {
        window.setTimeout(() => {
          if (runTokenRef.current !== token) return;
          setPhase('morphing');
          const layoutB = sampleTextToParticles(response.b.content);
          scene.morphTo(layoutB, { durationMs: 2600, burstRadius: 7.5 });
          window.setTimeout(() => {
            if (runTokenRef.current !== token) return;
            setPhase('idle');
            scene.setPhase('idle');
          }, 2700);
        }, 900);
      }
    } catch (cause) {
      if (runTokenRef.current !== token) return;
      const failure =
        cause instanceof CompareError
          ? cause
          : new CompareError({ message: cause instanceof Error ? cause.message : String(cause) });
      setError(failure);
      setPhase('error');
      scene.setPhase('error');
    }
  }, [prompt, settings]);

  const copyRunJson = useCallback(async () => {
    if (!run) return;
    const payload = {
      ...run,
      verdict: run.identical ? 'IDENTICAL' : 'DIVERGED',
      settings: {
        baseUrl: settings.baseUrl,
        modelA: settings.modelA,
        modelB: settings.modelB,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        disableReasoning: settings.disableReasoning,
      },
      particles: {
        poolSize: 220000,
        movedParticles: stats.movedParticles,
        maxDisplacement: Number(stats.maxDisplacement.toFixed(4)),
      },
      note: 'apiKey is intentionally omitted from this export.',
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [run, settings, stats]);

  const busy = phase === 'calling' || phase === 'laying-out' || phase === 'morphing';
  const verdict = run ? (run.identical ? 'IDENTICAL' : 'DIVERGED') : null;

  const movedDisplay = useMemo(() => {
    if (phase === 'identical') return 0;
    return stats.movedParticles;
  }, [phase, stats.movedParticles]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true" />
          <div>
            <h1 className="topbar__title">The Identical Twins Test</h1>
            <p className="topbar__sub">
              One prompt. Two models. If the answers are byte-identical, nothing moves.
            </p>
            <p className="topbar__by">
              Built by{' '}
              <a href="https://harishkotra.me" target="_blank" rel="noopener noreferrer">
                Harish Kotra
              </a>
              <span className="topbar__by-sep" aria-hidden="true">
                ·
              </span>
              <a href="https://dailybuild.xyz" target="_blank" rel="noopener noreferrer">
                Checkout my other builds
              </a>
            </p>
          </div>
        </div>

        <div className="topbar__actions">
          <span className={`phase phase--${phase}`}>
            <span className="phase__dot" aria-hidden="true" />
            {PHASE_LABEL[phase]}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <main className="stage" ref={stageRef}>
        <div className="stage__canvas">
          <canvas ref={canvasRef} className="canvas" />

          {/* The money shot: a locked cloud gets a stamped badge and a zero counter. */}
          {phase === 'identical' && run ? (
            <div className="lock" role="status">
              <div className="lock__badge">
                <span className="lock__badge-text">IDENTICAL</span>
                <span className="lock__badge-sub">byte-for-byte</span>
              </div>
              <div className="lock__meter">
                <span className="lock__meter-value">0</span>
                <span className="lock__meter-label">particles moved</span>
              </div>
            </div>
          ) : null}

          {phase === 'morphing' && run ? (
            <div className="lock lock--diverged" role="status">
              <div className="lock__badge lock__badge--diverged">
                <span className="lock__badge-text">DIVERGED</span>
                <span className="lock__badge-sub">
                  {movedDisplay.toLocaleString()} particles moved
                </span>
              </div>
            </div>
          ) : null}

          {!run && !busy && !error ? (
            <div className="stage__hint">
              <p className="stage__hint-title">Pick a prompt and run the test.</p>
              <p className="stage__hint-body">
                Each answer becomes a cloud of particles, one per sampled point. The app then tries to
                morph A into B — and reports what actually happened.
              </p>
            </div>
          ) : null}

          <div className="hud" aria-live="polite">
            <div className="hud__row">
              <span className="hud__key">Verdict</span>
              <span className={`hud__value hud__value--${verdict === 'IDENTICAL' ? 'same' : verdict === 'DIVERGED' ? 'diff' : 'idle'}`}>
                {verdict ?? (busy ? 'pending' : '—')}
              </span>
            </div>
            <div className="hud__row">
              <span className="hud__key">sha256 equal</span>
              <span className="hud__value hud__value--mono">
                {run ? (run.hashEqual ? 'true' : 'false') : '—'}
              </span>
            </div>
            <div className="hud__row">
              <span className="hud__key">Particles moved</span>
              <span className="hud__value hud__value--mono">{phase === 'identical' ? '0' : movedDisplay.toLocaleString()}</span>
            </div>
            <div className="hud__row">
              <span className="hud__key">Renderer</span>
              <span className="hud__value hud__value--mono">{stats.fps} fps</span>
            </div>
            {run ? (
              <div className="hud__row hud__row--wide">
                <span className="hud__key">Run id</span>
                <span className="hud__value hud__value--mono hud__value--tiny">{shortHash(run.runId, 13)}</span>
              </div>
            ) : null}
          </div>

          <div className="models">
            <ModelColumn slot="A" role="older" result={run?.a ?? null} pending={phase === 'calling'} />
            <ModelColumn slot="B" role="newer" result={run?.b ?? null} pending={phase === 'calling'} />
          </div>
        </div>

        <aside className="console">
          <section className="panel">
            <label className="field">
              <span className="field__label">Prompt</span>
              <textarea
                className="input input--area"
                rows={3}
                value={prompt}
                spellCheck={false}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask both models the same thing…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void runComparison();
                  }
                }}
              />
            </label>

            <div className="presets">
              {PRESET_GROUPS.map((group) => (
                <section className="preset-group" key={group.title}>
                  <header className="preset-group__head">
                    <h3 className="preset-group__title">{group.title}</h3>
                    <p className="preset-group__note">{group.note}</p>
                  </header>
                  <div className="preset-group__list">
                    {group.presets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`preset preset--${preset.expect}${prompt === preset.prompt ? ' preset--selected' : ''}`}
                        onClick={() => setPrompt(preset.prompt)}
                        title={preset.prompt}
                      >
                        <span className="preset__main">
                          <span className="preset__label">{preset.label}</span>
                          <span className="preset__shape">{preset.shape}</span>
                        </span>
                        <span className="preset__expect">
                          {preset.expect === 'identical' ? 'IDENTICAL' : 'DIVERGED'}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <button
              type="button"
              className="btn btn--primary btn--run"
              onClick={() => (settings.apiKey ? void runComparison() : setSettingsOpen(true))}
              disabled={busy}
            >
              {busy ? PHASE_LABEL[phase] : settings.apiKey ? 'Run the test' : 'Add your API key'}
            </button>

            {!settings.apiKey ? (
              <p className="panel__notice">
                This app talks to a real model provider, so it needs your API key. Add one in
                Settings and use <strong>Test connection</strong> to check it before running.
              </p>
            ) : null}

            <div className="panel__meta">
              <span className="panel__meta-item">
                temp <code>{settings.temperature}</code>
              </span>
              <span className="panel__meta-item">
                max_tokens <code>{settings.maxTokens}</code>
              </span>
              <span className="panel__meta-item">
                reasoning <code>{settings.disableReasoning ? 'off' : 'on'}</code>
              </span>
              {!settings.apiKey ? <span className="panel__meta-item panel__meta-item--warn">no API key set</span> : null}
            </div>
          </section>

          {/* If both slots were served the same model, the verdict is explained by the
              provider's routing, not by the two models agreeing. Say so before the
              frozen cloud is read as a discovery. */}
          {run?.sameModelId ? (
            <section className="panel panel--collide" role="alert">
              <h2 className="panel__title">Same model served twice</h2>
              <p className="collide__body">
                Both model names resolved to <code>{run.a.servedModel}</code>, so this run
                compared that model against itself. The verdict below is explained by the
                provider&apos;s routing, not by the two models agreeing.
              </p>
              <p className="collide__hint">
                {run.a.aliased ? (
                  <>
                    Model A: asked for <code>{run.a.requestedModel}</code>, served{' '}
                    <code>{run.a.servedModel}</code>.{' '}
                  </>
                ) : null}
                {run.b.aliased ? (
                  <>
                    Model B: asked for <code>{run.b.requestedModel}</code>, served{' '}
                    <code>{run.b.servedModel}</code>.{' '}
                  </>
                ) : null}
                Point the two slots at model names that resolve to different ids.
              </p>
              <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
            </section>
          ) : null}

          {error ? (
            <section className="panel panel--error" role="alert">
              <h2 className="panel__title">The provider refused the request</h2>
              <p className="error__message">{error.detail.message}</p>
              {error.detail.slot ? <p className="error__meta">Model {error.detail.slot}</p> : null}
              {error.detail.providerBody ? (
                <pre className="error__body">{error.detail.providerBody}</pre>
              ) : null}
              <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
            </section>
          ) : null}

          <section className="panel">
            <DiffStrip run={run} />
            {run ? (
              <div className="hashes">
                <div className="hashes__item hashes__item--a">
                  <span className="hashes__label">A · {run.a.servedModel}</span>
                  <code className="hashes__value">{run.a.sha256}</code>
                </div>
                <div className="hashes__item hashes__item--b">
                  <span className="hashes__label">B · {run.b.servedModel}</span>
                  <code className="hashes__value">{run.b.sha256}</code>
                </div>
                <p className={`hashes__verdict hashes__verdict--${run.identical ? 'same' : 'diff'}`}>
                  {run.identical
                    ? 'Digests are equal. The two answers are the same bytes.'
                    : 'Digests differ. The two answers are not the same bytes.'}
                </p>
                <p className="hashes__nonce">
                  Nonce sent this run: <code>{run.nonce}</code>
                </p>
                <div className="hashes__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => void copyRunJson()}>
                    {copied ? 'Copied' : 'Copy run as JSON'}
                  </button>
                  <span className="hashes__timing">
                    A {formatMs(run.a.latencyMs)} · B {formatMs(run.b.latencyMs)}
                  </span>
                </div>
              </div>
            ) : null}
          </section>

          <RunHistory
            runs={runs}
            activeId={run?.runId ?? null}
            onSelect={(record) => {
              setRun(record.raw);
              setError(null);
              setPhase(record.identical ? 'identical' : 'idle');
              const scene = sceneRef.current;
              if (!scene) return;
              scene.resetCamera();
              scene.setLayoutA(sampleTextToParticles(record.a.content));
              if (record.identical) scene.lock();
            }}
            onClear={() => setRuns([])}
          />
        </aside>
      </main>

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <footer className="foot">
        <div className="foot__meta">
          <span>{sceneReady ? 'WebGL scene live' : 'Starting renderer…'}</span>
          <span>Particle pool 220,000 · one particle per sampled point</span>
          <span>Verdict computed server-side from sha256 of the response bytes</span>
        </div>

        <div className="foot__credit">
          <span>
            Built by{' '}
            <a href="https://harishkotra.me" target="_blank" rel="noopener noreferrer">
              Harish Kotra
            </a>
          </span>
          <span className="foot__sep" aria-hidden="true">
            ·
          </span>
          <span>
            <a href="https://dailybuild.xyz" target="_blank" rel="noopener noreferrer">
              Checkout my other builds
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}