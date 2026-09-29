/**
 * The aeroplanes from the book, ready to open.
 *
 * Each is the book's own sequence written out as a session file (see
 * `scripts/samples.ts` and `export-sample.ts`), so opening one gives every step
 * in the list - selectable, editable, and folded exactly as the page draws
 * it. They are here to be looked at and learned from, next to the shelf of
 * planes you fold yourself, not instead of it.
 */
export interface BookPlane {
  readonly name: string;
  /** Session file served next to the app. */
  readonly file: string;
  /** One line on what makes it that aeroplane. */
  readonly note: string;
}

export const BOOK_PLANES: readonly BookPlane[] = [
  { name: '드롭십', file: 'jet.json', note: '9단계 · 넓은 날개, 위로 선 윙릿' },
  { name: '트라이앵글', file: 'triangle.json', note: '13단계 · 물폭탄 접기로 만든 삼각 날개' },
  { name: '트랜지션', file: 'transition.json', note: '13단계 · 코끝을 안쪽으로 접어 넣어 잠가요' },
  { name: '이지로크 스카이킹', file: 'skyking.json', note: '12단계 · 코 삼각형 끝으로 날개를 눌러 잠가요' },
  { name: '버드맨', file: 'birdman.json', note: '13단계 · 앞전을 여러 번 말아 두껍고 튼튼한 날개' },
  { name: '오르막길', file: 'highest.json', note: '18단계 · 코를 열 번 말아 만든 넓은 글라이더' },
];
