'use client';

/**
 * The nurse's offline outbox (IPD plan §5.6): an entry that could not reach
 * the server waits here, on the phone, and is sent when the connection comes
 * back. IndexedDB with no library — this is one object store.
 *
 * Every entry carries the client id generated when Save was tapped, so the
 * server records it once however many times the outbox retries
 * (care_entries_client_key). Nothing is ever dropped silently: an entry is
 * removed only when the server has answered for it.
 */

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

const DB_NAME = 'qurio-ward';
const STORE = 'outbox';
export const OUTBOX_EVENT = 'qurio-outbox-changed';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'clientId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const announce = () => window.dispatchEvent(new Event(OUTBOX_EVENT));

export async function queueEntries(entries: readonly OutboxEntry[]): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      for (const entry of entries) tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  announce();
}

export const pendingEntries = (): Promise<OutboxEntry[]> =>
  run('readonly', (store) => store.getAll() as IDBRequest<OutboxEntry[]>);

async function remove(clientIds: readonly string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      for (const id of clientIds) tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  announce();
}

/** What the server is sent: the outbox row without its display-only fields. */
const toRequest = (entry: OutboxEntry) => ({
  clientId: entry.clientId,
  admissionId: entry.admissionId,
  item: entry.item,
  quantity: entry.quantity,
  occurredAt: entry.occurredAt,
});

export type SendOutcome =
  | { kind: 'sent'; results: EntryResult[] }
  /** The network or the server is down: keep the entries and try later. */
  | { kind: 'offline' }
  /** Logged out: keep the entries; they go once the nurse signs in again. */
  | { kind: 'signed_out' };

/** Sends entries now. The caller decides what to do with an offline answer. */
export async function sendEntries(entries: readonly OutboxEntry[]): Promise<SendOutcome> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { kind: 'offline' };
  try {
    const response = await fetch('/api/ipd/care-entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: entries.map(toRequest) }),
    });
    if (response.status === 401) return { kind: 'signed_out' };
    if (response.status >= 500) return { kind: 'offline' };
    const body = (await response.json()) as { results?: EntryResult[]; error?: string };
    if (!response.ok || !body.results) {
      // A refused request (bad shape, no permission) will never succeed on a
      // retry; report every entry as failed so the nurse sees it.
      return {
        kind: 'sent',
        results: entries.map((entry) => ({ clientId: entry.clientId, ok: false, error: body.error ?? 'Not saved' })),
      };
    }
    return { kind: 'sent', results: body.results };
  } catch {
    return { kind: 'offline' };
  }
}

let flushing: Promise<{ sent: number; failed: EntryResult[] }> | null = null;

/**
 * Sends everything waiting. Runs on page load and whenever the phone comes
 * back online. One flush at a time; a second call joins the first.
 */
export function flushOutbox(): Promise<{ sent: number; failed: EntryResult[] }> {
  flushing ??= (async () => {
    try {
      const waiting = await pendingEntries();
      if (waiting.length === 0) return { sent: 0, failed: [] };
      const failed: EntryResult[] = [];
      let sent = 0;
      for (let i = 0; i < waiting.length; i += 50) {
        const batch = waiting.slice(i, i + 50);
        const outcome = await sendEntries(batch);
        if (outcome.kind !== 'sent') break;
        await remove(outcome.results.map((result) => result.clientId));
        for (const result of outcome.results) {
          if (result.ok) sent += 1;
          else failed.push(result);
        }
      }
      return { sent, failed };
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
