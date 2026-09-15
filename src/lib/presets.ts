/**
 * The preset library.
 *
 * Presets are grouped by what the particle cloud will probably do, because that is
 * the thing worth choosing between: a run where the silhouette changes is a far more
 * dramatic morph than one where only the wording changes.
 *
 * `shape` is a hint, not a promise. The verdict and the two clouds depend entirely on
 * what the two models actually return — a short factual answer usually comes back
 * byte-identical, and an open-ended one usually does not, but nothing here is
 * guaranteed. The app reports what really happened; these labels only set expectations.
 */

export interface Preset {
  label: string;
  prompt: string;
  expect: 'identical' | 'diverged';
  /** What the two clouds are likely to look like — the reason to pick this one. */
  shape: string;
}

export interface PresetGroup {
  title: string;
  note: string;
  presets: Preset[];
}

export const PRESET_GROUPS: PresetGroup[] = [
  {
    title: 'Likely identical',
    note: 'Short, factual answers with one obvious wording. Watch for the lock.',
    presets: [
      {
        label: 'Recursion, one sentence',
        prompt: 'Explain recursion in exactly one sentence, no examples.',
        expect: 'identical',
        shape: 'a paragraph → the same paragraph',
      },
      {
        label: 'Capital of France',
        prompt: 'What is the capital of France? Answer with just the city name.',
        expect: 'identical',
        shape: 'a tiny cloud → the same tiny cloud',
      },
      {
        label: 'Count to five',
        prompt: 'Count from 1 to 5. Output only the digits, separated by commas.',
        expect: 'identical',
        shape: 'one short line → the same line',
      },
    ],
  },
  {
    title: 'Likely different shapes',
    note: 'Open-ended drawing tasks. The silhouette itself tends to change.',
    presets: [
      {
        label: 'Cat in ASCII',
        prompt: 'Draw a cat in ASCII.',
        expect: 'diverged',
        shape: 'line art → line art',
      },
      {
        label: 'House in ASCII',
        prompt: 'Draw a simple house using ASCII characters.',
        expect: 'diverged',
        shape: 'roof and walls → a different roof',
      },
      {
        label: 'HELLO in block letters',
        prompt: 'Write the word HELLO in large ASCII block letters.',
        expect: 'diverged',
        shape: 'wide blocks → wide blocks',
      },
      {
        label: 'Count to 20, one per line',
        prompt: 'Count from 1 to 20, one number per line, nothing else.',
        expect: 'diverged',
        shape: 'a tall column → short wide rows',
      },
    ],
  },
  {
    title: 'Likely different density',
    note: 'Answers that vary in length, so the cloud thickens or thins.',
    presets: [
      {
        label: 'Haiku, rain on a window',
        prompt: 'Write a haiku about rain on a window. Output only the haiku.',
        expect: 'diverged',
        shape: 'three short lines → three short lines',
      },
      {
        label: 'Ocean in 200 words',
        prompt: 'Describe the ocean in about 200 words.',
        expect: 'diverged',
        shape: 'a dense wall → a denser wall',
      },
      {
        label: 'Python reverse function',
        prompt: 'Write a Python function that reverses a string. Output only the code, no explanation.',
        expect: 'diverged',
        shape: 'a few lines of code → more lines of code',
      },
      {
        label: 'Planets table',
        prompt: 'Give a markdown table of three planets and one moon each.',
        expect: 'diverged',
        shape: 'a grid → a different grid',
      },
    ],
  },
];

/** Flat view, for anything that just needs every preset. */
export const ALL_PRESETS: Preset[] = PRESET_GROUPS.flatMap((group) => group.presets);