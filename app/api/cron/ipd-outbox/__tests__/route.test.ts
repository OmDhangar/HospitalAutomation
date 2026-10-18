import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../route';

// Mock ipd-emar-outbox service
vi.mock('@/lib/services/ipd-emar-outbox', () => ({
  processPendingOutboxBatch: vi.fn().mockResolvedValue({
    processed: 2,
    pendingPricing: 0,
    failed: 0,
  }),
  recoverStuckOutboxClaims: vi.fn().mockResolvedValue(0),
}));

// Mock admin DB or hospital query if needed
vi.mock('@/lib/db/admin', () => ({
  getAdminDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: 'hosp-1' }]),
      }),
    }),
  }),
}));

describe('Cron IPD Outbox Route Handler (/api/cron/ipd-outbox)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-cron-secret-12345';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('rejects with 503 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_TICK_SECRET;

    const request = new Request('http://localhost:3000/api/cron/ipd-outbox', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret-12345' },
    });

    const response = await POST(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('CRON_SECRET is not set');
  });

  it('rejects with 401 when authorization header is missing or incorrect', async () => {
    const requestMissing = new Request('http://localhost:3000/api/cron/ipd-outbox', {
      method: 'POST',
    });

    const responseMissing = await POST(requestMissing);
    expect(responseMissing.status).toBe(401);

    const requestWrong = new Request('http://localhost:3000/api/cron/ipd-outbox', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    });

    const responseWrong = await POST(requestWrong);
    expect(responseWrong.status).toBe(401);
  });

  it('accepts valid bearer authorization and executes outbox processing', async () => {
    const request = new Request('http://localhost:3000/api/cron/ipd-outbox?hospitalId=hosp-1', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret-12345' },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
  });
});
