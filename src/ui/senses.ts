import type { FoldSense } from '../geometry/fold.js';

export interface SenseInfo {
  readonly id: FoldSense;
  readonly mark: string;
  readonly name: string;
  readonly hint: string;
}

export const SENSES: readonly SenseInfo[] = [
  {
    id: 'valley', mark: '▽', name: '앞으로',
    hint: '접은 조각이 나머지 위에 얹힙니다.',
  },
  {
    id: 'mountain', mark: '△', name: '뒤로',
    hint: '접은 조각이 나머지 뒤로 들어갑니다.',
  },
];

export const senseMark = (s: FoldSense): string =>
  SENSES.find((e) => e.id === s)?.mark ?? '▽';
