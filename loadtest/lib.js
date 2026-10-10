// Shared helpers for the k6 scripts (IPD sheets plan §2.2, §2.4).
// k6 runs this file in its own JavaScript runtime, not Node: no npm imports.

import http from 'k6/http';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

/** Written by scripts/synth/generate.ts; valid only against the load database it names. */
export const FIXTURE = JSON.parse(open('./.sessions.json'));

export function hospitalFor(vu) {
  const hospitals = FIXTURE.hospitals;
  return hospitals[(vu - 1) % hospitals.length];
}

export function authed(token) {
  return { headers: { Cookie: `opd_session=${token}`, 'Content-Type': 'application/json' } };
}

export function uuid() {
  // RFC 4122 v4 from Math.random — enough for client ids in a load test.
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function get(path, token, tags) {
  return http.get(`${BASE_URL}${path}`, { ...authed(token), tags });
}

export function post(path, token, body, tags) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), { ...authed(token), tags });
}
