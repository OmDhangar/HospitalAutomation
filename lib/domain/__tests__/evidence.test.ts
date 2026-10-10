import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  canonicalEvent,
  digestHash,
  eventHash,
  eventLabel,
  leafHash,
  merkleRoot,
  type EventFields,
} from '../evidence';

/**
 * Certificate Transparency's Merkle tree test vectors (RFC 6962 reference
 * implementation): the root over the first n of these leaves.
 */
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

const event = (over: Partial<EventFields> = {}): EventFields => ({
  seq: '42',
  hospitalId: '11111111-1111-4111-8111-111111111111',
  branchId: null,
  occurredAtMicros: '1791633600000000',
  recordedAtMicros: '1791633660123456',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  witnessUserId: null,
  channel: 'ward_device',
  deviceId: 'dev-1',
  sessionId: null,
  action: 'chart_entry.created',
  objectType: 'chart_entry',
  objectId: '33333333-3333-4333-8333-333333333333',
  payloadText: '{"pulse": 82}',
  ...over,
});

describe('the Merkle tree', () => {
  it('matches the Certificate Transparency test vectors for 1 to 8 leaves', () => {
    const leaves = CT_LEAVES.map((hex) => leafHash(Buffer.from(hex, 'hex')));
    for (let n = 1; n <= leaves.length; n += 1) {
      expect(merkleRoot(leaves.slice(0, n)).toString('hex'), `${n} leaves`).toBe(CT_ROOTS[n - 1]);
    }
  });

  it('changes when a leaf is changed, removed, added or moved', () => {
    const leaves = ['a', 'b', 'c', 'd', 'e'].map((x) => leafHash(x));
    const root = merkleRoot(leaves).toString('hex');
    expect(merkleRoot([...leaves.slice(0, 2), leafHash('X'), ...leaves.slice(3)]).toString('hex')).not.toBe(root);
    expect(merkleRoot(leaves.slice(0, 4)).toString('hex')).not.toBe(root);
    expect(merkleRoot([...leaves, leafHash('f')]).toString('hex')).not.toBe(root);
    expect(merkleRoot([leaves[1], leaves[0], ...leaves.slice(2)]).toString('hex')).not.toBe(root);
  });
});

describe('an event row', () => {
  it('is hashed over every field, in a fixed order', () => {
    expect(canonicalEvent(event()).split('\u001f')).toHaveLength(15);
    const base = eventHash(event()).toString('hex');
    for (const change of [
      { seq: '43' },
      { actorUserId: null },
      { channel: 'personal' },
      { payloadText: '{"pulse": 92}' },
      { recordedAtMicros: '1791633660123457' },
      { action: 'chart_entry.voided' },
    ]) {
      expect(eventHash(event(change)).toString('hex'), JSON.stringify(change)).not.toBe(base);
    }
  });
});

describe('a digest', () => {
  it('commits to the one before it', () => {
    const fields = {
      hospitalId: event().hospitalId,
      digestNo: 1,
      seqFrom: '0',
      seqTo: '42',
      eventCount: 3,
      merkleRoot: leafHash('root'),
      prevHash: GENESIS_HASH,
    };
    const first = digestHash(fields);
    expect(digestHash({ ...fields, prevHash: leafHash('other') }).equals(first)).toBe(false);
    expect(digestHash({ ...fields, eventCount: 4 }).equals(first)).toBe(false);
  });
});

describe('labels', () => {
  it('says what happened in plain words, and shows unknown actions as written', () => {
    expect(eventLabel('chart_entry.voided')).toBe('T.P.R. reading struck through');
    expect(eventLabel('something.new')).toBe('something.new');
  });
});

describe('history lines', () => {
  it('turns an event’s numbers into words', async () => {
    const { eventDetail } = await import('../evidence');
    expect(eventDetail('chart_entry.created', { pulse: 82, bp_systolic: 110, bp_diastolic: 70, temp_f_tenths: 1000, on_oxygen: true })).toBe(
      'Pulse 82 · B.P. 110/70 · Temp 100.0 · on oxygen',
    );
    expect(eventDetail('care_entry.created', { quantity: 2 })).toBe('× 2');
    expect(eventDetail('bill_item.created', { total_paise: 3000, quantity: 2 })).toBe('₹30.00 · × 2');
    expect(eventDetail('admission.changed', { status: 'discharge_ready' })).toBe('ready for discharge');
    expect(eventDetail('record_access.created', { action: 'print_ipd_file' })).toBe('printed the patient file');
    expect(eventDetail('auth.login', {})).toBeNull();
  });
});
