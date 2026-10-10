// The 8 am shift change (IPD sheets plan §2.1): nurses record a burst of bedside
// entries while the desk and other nurses keep the ward and census pages open.
//
//   k6 run loadtest/shift-change.js                       # against BASE_URL (default localhost:3000)
//   k6 run -e BASE_URL=https://staging.example loadtest/shift-change.js
//
// Budgets are the §2.2 numbers; k6 exits non-zero when a threshold fails.

import { check, sleep } from 'k6';
import { FIXTURE, get, hospitalFor, pick, post, uuid } from './lib.js';

const NURSES = Number(__ENV.NURSES || Math.min(200, FIXTURE.hospitals.length * 4));

export const options = {
  scenarios: {
    record: {
      executor: 'ramping-vus',
      exec: 'record',
      startVUs: 0,
      stages: [
        { duration: '2m', target: NURSES },
        { duration: '16m', target: NURSES },
        { duration: '2m', target: 0 },
      ],
    },
    census: {
      executor: 'constant-vus',
      exec: 'census',
      vus: Math.max(1, Math.floor(NURSES / 4)),
      duration: '20m',
    },
  },
  thresholds: {
    'http_req_duration{kind:write}': ['p(95)<250', 'p(99)<600'],
    'http_req_duration{kind:page}': ['p(95)<400', 'p(99)<1000'],
    'checks{kind:write}': ['rate>0.999'],
    http_req_failed: ['rate<0.001'],
  },
};

export function record() {
  const hospital = hospitalFor(__VU);
  if (!hospital.admissions.length) return sleep(5);
  const token = hospital.sessions.nurse;
  const admissionId = pick(hospital.admissions);
  const entries = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({
    clientId: uuid(),
    admissionId,
    item: { type: 'medicine', id: pick(hospital.medicines) },
    quantity: 1,
    occurredAt: new Date(Date.now() - Math.floor(Math.random() * 10) * 60_000).toISOString(),
  }));
  const res = post('/api/ipd/care-entries', token, { entries }, { kind: 'write' });
  check(res, { 'entries saved': (r) => r.status === 200 }, { kind: 'write' });
  // A nurse records a reading or a dose roughly every 20–40 seconds at the peak.
  sleep(20 + Math.random() * 20);
}

export function census() {
  const hospital = hospitalFor(__VU);
  const res = get('/ipd', hospital.sessions.owner, { kind: 'page' });
  check(res, { 'census page': (r) => r.status === 200 }, { kind: 'page' });
  // The census auto-refreshes every 15 s.
  sleep(15);
}
