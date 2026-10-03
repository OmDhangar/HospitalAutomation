import { EventEmitter } from 'events';

/**
 * Central event broadcaster for Real-Time TV Display updates.
 *
 * Emits lightweight notifications whenever reception or doctors mutate queue state
 * (calling next patient, advancing queue, pausing/resuming doctor, adding walk-ins).
 * Connected waiting room displays listen via Server-Sent Events (SSE) and refresh
 * instantly (<50ms) instead of waiting for a 10s polling interval.
 */

interface GlobalWithEventEmitter {
  displayEventEmitter?: EventEmitter;
}

const globalForEvents = globalThis as unknown as GlobalWithEventEmitter;

export const displayEvents = globalForEvents.displayEventEmitter || new EventEmitter();

if (process.env.NODE_ENV !== 'production') {
  globalForEvents.displayEventEmitter = displayEvents;
}

displayEvents.setMaxListeners(250);

/**
 * Notifies all active waiting room displays for the given hospital and branch that
 * the queue has moved.
 */
export function notifyQueueMovement(hospitalId: string, branchId?: string | null) {
  const payload = { timestamp: Date.now() };
  displayEvents.emit(`hospital:${hospitalId}`, payload);
  if (branchId) {
    displayEvents.emit(`branch:${branchId}`, payload);
  }
}
