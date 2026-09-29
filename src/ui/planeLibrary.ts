/**
 * The planes you have folded, kept between visits.
 *
 * Saving to a file already works and is the thing to use when the work has to
 * leave this browser. What it does not do is keep a shelf: every save is a
 * download with a made-up name, and getting one back means finding it again in
 * a folder. A plane you are still working on wants a name and a list.
 *
 * There is no server, so the shelf is the browser's own storage. That decides
 * its limits honestly - it belongs to one browser on one machine, and clearing
 * site data clears it - which is why the file save stays exactly as it was.
 *
 * What is stored is the session file's own text, not a parsed copy. Reading it
 * back therefore goes through the same reader that opening a file does: a
 * shelved plane is checked field by field like any other, and one that has been
 * damaged is dropped rather than replayed into a shape that never existed.
 */

import type { ElevatorTune } from './elevator.js';
import { readSessionFile } from './sessionFile.js';
import type { Step } from './foldSession.js';

/** The part of `localStorage` this needs, so a test can hand it a plain object. */
export interface Shelf {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SHELF_KEY = 'paper-plane.planes.v1';

export interface SavedPlane {
  readonly id: string;
  readonly name: string;
  /** ISO time it was put on the shelf, for the person reading the list. */
  readonly saved: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly gsm: number;
  readonly steps: Step[];
  /** The trailing edges' tuning, when it was bent; not a step, but the plane's. */
  readonly elevator?: ElevatorTune;
  /** Finished, or still being folded. */
  readonly done: boolean;
  /** The wings' V, degrees from spread square to the body. */
  readonly vee?: number;
}

/** Two names are the same name if only their spacing and case differ. */
export const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

interface Shelved {
  id: string;
  name: string;
  saved: string;
  /** The session file, as the text a save would have written. */
  text: string;
}

const rows = (shelf: Shelf): Shelved[] => {
  let raw: string | null = null;
  try {
    raw = shelf.getItem(SHELF_KEY);
  } catch {
    // Storage can be switched off entirely; an empty shelf is the honest answer.
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const { id, name, saved, text } = row as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    if (typeof text !== 'string') return [];
    return [{ id, name, saved: typeof saved === 'string' ? saved : '', text }];
  });
};

const put = (shelf: Shelf, list: Shelved[]): void => {
  try {
    shelf.setItem(SHELF_KEY, JSON.stringify(list));
  } catch {
    // Full, or refused. Nothing here can fix that; the caller reads the shelf
    // back and sees what actually landed.
  }
};

/**
 * Everything on the shelf, newest first, each one read the way a file is read.
 *
 * A row whose session no longer parses is left out rather than repaired. Half
 * of a fold script is not a plane, and replaying one would draw a shape that
 * was never folded.
 */
export function readShelf(shelf: Shelf): SavedPlane[] {
  const out: SavedPlane[] = [];
  for (const row of rows(shelf)) {
    try {
      const loaded = readSessionFile(row.text);
      out.push({
        id: row.id,
        name: row.name,
        saved: row.saved,
        widthMm: loaded.widthMm,
        heightMm: loaded.heightMm,
        gsm: loaded.gsm,
        steps: loaded.steps,
        ...(loaded.elevator ? { elevator: loaded.elevator } : {}),
        done: loaded.done,
        ...(loaded.vee !== undefined ? { vee: loaded.vee } : {}),
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.saved.localeCompare(a.saved));
}

/**
 * Put a plane on the shelf under a name, and give the whole shelf back.
 *
 * A name already in use is overwritten in place rather than added beside
 * itself: two rows called the same thing is a list you cannot read, and saving
 * again while working on one plane is the ordinary case, not a new plane.
 */
export function shelvePlane(shelf: Shelf, name: string, text: string): SavedPlane[] {
  const now = new Date().toISOString();
  const list = rows(shelf);
  const at = list.findIndex((row) => sameName(row.name, name));
  const row: Shelved = {
    id: at >= 0 ? list[at]!.id : `${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    saved: now,
    text,
  };
  if (at >= 0) list[at] = row; else list.push(row);
  put(shelf, list);
  return readShelf(shelf);
}

/** Take one off the shelf, and give the rest back. */
export function dropPlane(shelf: Shelf, id: string): SavedPlane[] {
  put(shelf, rows(shelf).filter((row) => row.id !== id));
  return readShelf(shelf);
}

/*
 * Book planes the pupil has taken off their list. The book's files cannot be
 * deleted, so taking one off is remembered by name - the one thing kept here
 * that is not a plane's own record, and only because there is no record of
 * its own to delete.
 */
export const HIDDEN_KEY = 'paper-plane.hidden-book.v1';
export function hiddenBook(shelf: Shelf): string[] {
  try {
    const raw = JSON.parse(shelf.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
export function hideBook(shelf: Shelf, name: string): string[] {
  const list = [...new Set([...hiddenBook(shelf), name.trim()])];
  shelf.setItem(HIDDEN_KEY, JSON.stringify(list));
  return list;
}
