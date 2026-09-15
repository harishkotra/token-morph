import type { RunRecord } from '../lib/api';

interface RunHistoryProps {
  runs: RunRecord[];
  activeId: string | null;
  onSelect: (run: RunRecord) => void;
  onClear: () => void;
}

export function RunHistory({ runs, activeId, onSelect, onClear }: RunHistoryProps) {
  const identical = runs.filter((r) => r.identical).length;
  const diverged = runs.length - identical;

  return (
    <section className="history" aria-label="Run history">
      <header className="history__head">
        <h2 className="history__title">Session tally</h2>
        {runs.length > 0 ? (
          <p className="history__counts">
            <span className="tally tally--same">{identical} identical</span>
            <span className="tally tally--diff">{diverged} diverged</span>
          </p>
        ) : (
          <p className="history__counts history__counts--empty">No runs yet</p>
        )}
        {runs.length > 0 ? (
          <button type="button" className="btn btn--ghost btn--small" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </header>

      <ol className="history__strip">
        {runs.length === 0 ? (
          <li className="history__empty">
            Every run lands here as a chip, so a session builds a tally of how often the two models agree.
          </li>
        ) : (
          runs.map((run, index) => (
            <li key={run.id}>
              <button
                type="button"
                className={`chip chip--${run.identical ? 'same' : 'diff'}${run.id === activeId ? ' chip--active' : ''}`}
                onClick={() => onSelect(run)}
                title={run.prompt}
              >
                <span className="chip__index">{String(index + 1).padStart(2, '0')}</span>
                <span className="chip__verdict">{run.identical ? 'IDENTICAL' : 'DIVERGED'}</span>
              </button>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}