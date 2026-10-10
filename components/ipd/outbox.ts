'use client';

import { OUTBOX_EVENT, createOutbox, type SendOutcome as CoreSendOutcome } from './outbox-core';

/**
 * The nurse's offline outbox for bedside entries (IPD plan §5.6). Built on
 * outbox-core; the database ('qurio-ward', version 1) and these exports are
 * unchanged, so entries queued by an older build are still sent.
 *
 * Every entry carries the client id generated when Save was tapped, so the
 * server records it once however many times the outbox retries
 * (care_entries_client_key).
 */

export { OUTBOX_EVENT };

export type OutboxEntry = {
  clientId: string;
  admissionId: string;
  item:
    | { type: 'medicine' | 'charge'; id: string }
    | { type: 'new'; kind: 'medicine' | 'consumable' | 'procedure'; name: string };
  quantity: number;
  occurredAt: string;
  /** For the "waiting to sync" list; never sent. */
  label: string;
  patientName: string;
  queuedAt: string;
};

export type EntryResult =
  | { clientId: string; ok: true; entryId: string; description: string }
  | { clientId: string; ok: false; error: string };

export type SendOutcome = CoreSendOutcome<EntryResult>;

const outbox = createOutbox<OutboxEntry, EntryResult>({
  dbName: 'qurio-ward',
  endpoint: '/api/ipd/care-entries',
  toRequest: (entry) => ({
    clientId: entry.clientId,
    admissionId: entry.admissionId,
    item: entry.item,
    quantity: entry.quantity,
    occurredAt: entry.occurredAt,
  }),
});

export const queueEntries = outbox.queue;
export const pendingEntries = outbox.pending;
/** Sends entries now. The caller decides what to do with an offline answer. */
export const sendEntries = outbox.send;
/** Sends everything waiting: on page load and whenever the phone comes back online. */
export const flushOutbox = outbox.flush;
