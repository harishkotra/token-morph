import type { CompareResponse } from '../lib/api';

/**
 * The signature readout: a per-character comparison of the two answers.
 *
 * Each tick is one character position. Ticks light up where the two strings differ,
 * so a run that reports DIVERGED shows exactly where the bytes stopped matching —
 * and a run that reports IDENTICAL shows a completely dark strip, which is the
 * visual proof that the verdict is not cosmetic.
 */
interface DiffStripProps {
  run: CompareResponse | null;
  /** Cap the number of rendered ticks so a long answer stays legible. */
  maxTicks?: number;
}

interface DiffCell {
  index: number;
  same: boolean;
  aChar: string;
  bChar: string;
}

function buildDiff(a: string, b: string, maxTicks: number): { cells: DiffCell[]; truncated: boolean } {
  const longest = Math.max(a.length, b.length);
  const truncated = longest > maxTicks;
  // When truncating, sample evenly across the whole answer so the shape of the
  // divergence is still visible rather than only the first N characters.
  const stride = truncated ? longest / maxTicks : 1;
  const cells: DiffCell[] = [];

  for (let i = 0; i < Math.min(longest, maxTicks); i += 1) {
    const index = truncated ? Math.floor(i * stride) : i;
    const aChar = a[index] ?? '';
    const bChar = b[index] ?? '';
    cells.push({ index, same: aChar === bChar, aChar, bChar });
  }

  return { cells, truncated };
}

export function DiffStrip({ run, maxTicks = 480 }: DiffStripProps) {
  if (!run) {
    return (
      <div className="diff diff--empty">
        <p className="diff__label">Character diff</p>
        <p className="diff__placeholder">Run a comparison to see where the two answers stop matching.</p>
      </div>
    );
  }

  const { cells, truncated } = buildDiff(run.a.content, run.b.content, maxTicks);
  const differing = cells.filter((c) => !c.same).length;
  const firstDiff = cells.find((c) => !c.same);

  return (
    <div className="diff">
      <div className="diff__head">
        <p className="diff__label">Character diff</p>
        <p className="diff__summary">
          {run.identical ? (
            <span className="diff__verdict diff__verdict--same">
              all {run.a.content.length.toLocaleString()} characters match
            </span>
          ) : (
            <span className="diff__verdict diff__verdict--diff">
              {differing.toLocaleString()} of {cells.length.toLocaleString()} sampled positions differ
              {firstDiff ? ` · first at char ${firstDiff.index.toLocaleString()}` : ''}
            </span>
          )}
        </p>
      </div>

      <div className="diff__strip" role="img" aria-label={run.identical ? 'No character differences' : 'Character differences highlighted'}>
        {cells.map((cell) => (
          <span
            key={cell.index}
            className={cell.same ? 'diff__tick' : 'diff__tick diff__tick--diff'}
            title={
              cell.same
                ? `char ${cell.index}: ${JSON.stringify(cell.aChar)}`
                : `char ${cell.index}: A ${JSON.stringify(cell.aChar)} → B ${JSON.stringify(cell.bChar)}`
            }
          />
        ))}
      </div>

      {truncated ? (
        <p className="diff__foot">
          Sampling {cells.length.toLocaleString()} of {Math.max(run.a.content.length, run.b.content.length).toLocaleString()} positions.
        </p>
      ) : null}
    </div>
  );
}