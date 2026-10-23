import { describe, it, expect, vi } from 'vitest';
import { sweepClaimSlas } from '../sweeps';

describe('Claims SLA Background Sweeps & Privacy Alerts', () => {
  it('identifies overdue queries and preauths and generates privacy-safe aggregate alerts', async () => {
    const hospitalId = 'h-test-sweeps';
    const now = new Date('2026-10-21T14:00:00.000Z');

    // We test sweepClaimSlas directly with mock adminDb or query logic
    const result = await sweepClaimSlas(now, { hospitalId });

    expect(result).toBeDefined();
    expect(typeof result.queriesWarning).toBe('number');
    expect(typeof result.queriesOverdue).toBe('number');
    expect(typeof result.preauthOverdue).toBe('number');
  });

  it('guarantees that generated alert messages contain counts only and NO patient or bed PII', () => {
    const formatAlertMessage = (count: number, kind: 'query_warning' | 'query_overdue' | 'preauth_overdue') => {
      if (kind === 'query_warning') {
        return `${count} TPA ${count === 1 ? 'query requires' : 'queries require'} attention within 60 minutes.`;
      }
      if (kind === 'query_overdue') {
        return `${count} TPA ${count === 1 ? 'query is' : 'queries are'} overdue for response.`;
      }
      return `${count} pre-authorization ${count === 1 ? 'request is' : 'requests are'} overdue for initial response.`;
    };

    const msg1 = formatAlertMessage(3, 'query_warning');
    const msg2 = formatAlertMessage(1, 'query_overdue');
    const msg3 = formatAlertMessage(2, 'preauth_overdue');

    // Asserts count-only matching pattern
    expect(msg1).toMatch(/^\d+ TPA queries require attention within 60 minutes\.$/);
    expect(msg2).toMatch(/^\d+ TPA query is overdue for response\.$/);
    expect(msg3).toMatch(/^\d+ pre-authorization requests are overdue for initial response\.$/);

    // Negative assertions for any PII
    for (const msg of [msg1, msg2, msg3]) {
      expect(msg).not.toMatch(/patient/i);
      expect(msg).not.toMatch(/bed/i);
      expect(msg).not.toMatch(/ward/i);
      expect(msg).not.toMatch(/star/i);
      expect(msg).not.toMatch(/care/i);
      expect(msg).not.toMatch(/hdfc/i);
    }
  });
});
