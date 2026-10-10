'use client';

import type { TprEntryInput } from '@/lib/domain/tpr';
import { createOutbox, type SendOutcome } from './outbox-core';

/**
 * Offline outbox for T.P.R. readings (IPD sheets plan B1). Its own database,
 * so the bedside-entry outbox ('qurio-ward' v1) is never upgraded or touched.
 * A reading saved with no signal waits here with its client id and the time
 * it was taken, and is charted once when the connection is back.
 */

export type TprOutboxEntry = TprEntryInput & {
  /** For the "waiting to sync" list; never sent. */
  label: string;
  patientName: string;
  queuedAt: string;
};

export type TprResult =
  | { clientId: string; ok: true; entryId: string; repeat: boolean }
  | { clientId: string; ok: false; error: string };

export type TprSendOutcome = SendOutcome<TprResult>;

const outbox = createOutbox<TprOutboxEntry, TprResult>({
  dbName: 'qurio-ward-tpr',
  endpoint: '/api/ipd/tpr',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toRequest: ({ label, patientName, queuedAt, ...reading }) => reading,
});

export const queueReadings = outbox.queue;
export const pendingReadings = outbox.pending;
export const sendReadings = outbox.send;
export const flushReadings = outbox.flush;
