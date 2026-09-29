/**
 * The long sums, off the page's thread: a card's hundred throws and the
 * search for its elevator take seconds, and run on the page they froze it -
 * a queue of cards kept working after the pupil had moved on to a tutorial.
 */

import { cardFlight, recommendAngle, recommendFor, recommendThrow } from './planeCard.js';
import type { PlaneRecord } from './planeCard.js';
import type { FlightSettings } from './flightReport.js';

export type Job =
  | { readonly id: number; readonly kind: 'card'; readonly record: PlaneRecord }
  | { readonly id: number; readonly kind: 'recommend'; readonly record: PlaneRecord; readonly settings?: FlightSettings }
  | { readonly id: number; readonly kind: 'angle'; readonly record: PlaneRecord; readonly settings?: FlightSettings }
  | { readonly id: number; readonly kind: 'throw'; readonly record: PlaneRecord; readonly settings?: FlightSettings };

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    const result = job.kind === 'card' ? cardFlight(job.record)
      : job.kind === 'angle' ? recommendAngle(job.record, job.settings)
        : job.kind === 'throw' ? recommendThrow(job.record, job.settings)
        : recommendFor(job.record, job.settings);
    self.postMessage({ id: job.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err) });
  }
};
