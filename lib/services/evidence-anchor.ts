import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where each sealed digest is copied outside the database (IPD sheets plan
 * §7.6): the copy that makes a rewrite of the database detectable, because
 * whoever rewrites it cannot also rewrite this.
 *
 * Today one kind of anchor, a directory (`EVIDENCE_ANCHOR_DIR`): one small
 * JSON file per digest, written once and never overwritten. In the S0 stage
 * (plan §9.2) that directory is synced to an S3 bucket in Mumbai with Object
 * Lock in compliance mode by the server's own tooling, so the app needs no
 * cloud SDK. An S3 anchor in the app is a later choice (decision D-STO); it
 * would implement this same interface.
 *
 * With no anchor configured, digests are still made and chained; the
 * Accountability page says they are not anchored.
 */

export type AnchorRecord = {
  hospitalId: string;
  digestNo: number;
  seqFrom: string;
  seqTo: string;
  eventCount: number;
  merkleRoot: string;
  prevHash: string;
  digestHash: string;
  signature: string | null;
  keyId: string | null;
  sealedAt: string;
};

export interface DigestAnchor {
  readonly kind: string;
  /** Stores the record; returns where. Refuses to replace a different record already there. */
  put(record: AnchorRecord): Promise<string>;
  /** The stored copy, or null when there is none. */
  get(hospitalId: string, digestNo: number): Promise<AnchorRecord | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DirectoryAnchor implements DigestAnchor {
  readonly kind = 'directory';
  constructor(private readonly root: string) {}

  private path(hospitalId: string, digestNo: number) {
    // Both parts are checked: the path is built from them.
    if (!UUID.test(hospitalId) || !Number.isSafeInteger(digestNo) || digestNo < 1) throw new Error('Bad anchor key');
    const name = `${String(digestNo).padStart(10, '0')}.json`;
    return { dir: join(this.root, hospitalId.toLowerCase()), ref: `${hospitalId.toLowerCase()}/${name}` };
  }

  async put(record: AnchorRecord): Promise<string> {
    const { dir, ref } = this.path(record.hospitalId, record.digestNo);
    await mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(record)}\n`;
    try {
      await writeFile(join(this.root, ref), body, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Written before (a retry after a crash): fine if identical, an alarm if not.
      const existing = await readFile(join(this.root, ref), 'utf8');
      if (existing !== body) throw new Error(`Anchor ${ref} already holds a different digest`);
    }
    return ref;
  }

  async get(hospitalId: string, digestNo: number): Promise<AnchorRecord | null> {
    const { ref } = this.path(hospitalId, digestNo);
    try {
      return JSON.parse(await readFile(join(this.root, ref), 'utf8')) as AnchorRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export function configuredAnchor(env: Record<string, string | undefined> = process.env): DigestAnchor | null {
  const dir = env.EVIDENCE_ANCHOR_DIR?.trim();
  return dir ? new DirectoryAnchor(dir) : null;
}
