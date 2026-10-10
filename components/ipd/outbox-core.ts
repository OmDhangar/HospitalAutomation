'use client';

/**
 * The machinery behind the phone's offline outboxes (IPD plan §5.6): an
 * entry that could not reach the server waits in IndexedDB and is sent when
 * the connection comes back. No library — each outbox is one object store in
 * its own database, so a new outbox never upgrades an old one.
 *
 * Every entry carries the client id made when Save was tapped, so the server
 * records it once however many times it is retried. Nothing is dropped
 * silently: an entry leaves the outbox only when the server has answered for it.
 */

export const OUTBOX_EVENT = 'qurio-outbox-changed';

export type OutboxResult = { clientId: string; ok: true } | { clientId: string; ok: false; error: string };

export type SendOutcome<R> =
  | { kind: 'sent'; results: R[] }
  /** The network or the server is down: keep the entries and try later. */
  | { kind: 'offline' }
  /** Logged out or locked: keep the entries; they go once the nurse is back in. */
  | { kind: 'signed_out' };

export type Outbox<E extends { clientId: string }, R extends { clientId: string; ok: boolean }> = {
  queue(entries: readonly E[]): Promise<void>;
  pending(): Promise<E[]>;
  send(entries: readonly E[]): Promise<SendOutcome<R>>;
  flush(): Promise<{ sent: number; failed: R[] }>;
};

export function createOutbox<E extends { clientId: string }, R extends { clientId: string; ok: boolean }>(config: {
  dbName: string;
  endpoint: string;
  /** What the server is sent: the row without its display-only fields. */
  toRequest: (entry: E) => unknown;
  batchSize?: number;
}): Outbox<E, R> {
  const STORE = 'outbox';
  const batchSize = config.batchSize ?? 50;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(config.dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'clientId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const write = async (work: (store: IDBObjectStore) => void): Promise<void> => {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    window.dispatchEvent(new Event(OUTBOX_EVENT));
  };

  const pending = async (): Promise<E[]> => {
    const db = await open();
    try {
      return await new Promise<E[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).getAll() as IDBRequest<E[]>;
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const queue = (entries: readonly E[]) =>
    write((store) => {
      for (const entry of entries) store.put(entry);
    });

  const remove = async (clientIds: readonly string[]) => {
    if (clientIds.length === 0) return;
    await write((store) => {
      for (const id of clientIds) store.delete(id);
    });
  };

  const send = async (entries: readonly E[]): Promise<SendOutcome<R>> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return { kind: 'offline' };
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: entries.map(config.toRequest) }),
      });
      if (response.status === 401) return { kind: 'signed_out' };
      if (response.status >= 500) return { kind: 'offline' };
      const body = (await response.json()) as { results?: R[]; error?: string };
      if (!response.ok || !body.results) {
        // A refused request (bad shape, no permission, module off) will never
        // succeed on a retry; report every entry as failed so the nurse sees it.
        return {
          kind: 'sent',
          results: entries.map((entry) => ({ clientId: entry.clientId, ok: false, error: body.error ?? 'Not saved' }) as unknown as R),
        };
      }
      return { kind: 'sent', results: body.results };
    } catch {
      return { kind: 'offline' };
    }
  };

  let flushing: Promise<{ sent: number; failed: R[] }> | null = null;

  /** Sends everything waiting. One flush at a time; a second call joins the first. */
  const flush = (): Promise<{ sent: number; failed: R[] }> => {
    flushing ??= (async () => {
      try {
        const waiting = await pending();
        if (waiting.length === 0) return { sent: 0, failed: [] };
        const failed: R[] = [];
        let sent = 0;
        for (let i = 0; i < waiting.length; i += batchSize) {
          const outcome = await send(waiting.slice(i, i + batchSize));
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
  };

  return { queue, pending, send, flush };
}
