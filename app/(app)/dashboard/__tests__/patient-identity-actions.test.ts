import { describe, expect, it, vi } from 'vitest';
import {
  checkMergeCriticalityDynamic,
  findPatientDuplicatesDynamic,
  mergePatientsDynamic,
} from '../patient-identity-actions';
import * as authModule from '@/lib/auth/session';
import * as mergeService from '@/lib/services/patient-merge';

describe('Patient Identity Server Actions (patient-identity-actions.ts)', () => {
  it('finds duplicate patient candidates for active staff session', async () => {
    vi.spyOn(authModule, 'requireSession').mockResolvedValue({
      userId: 'user-1',
      hospitalId: 'hospital-1',
      role: 'receptionist',
    } as any);

    vi.spyOn(mergeService, 'findPatientDuplicates').mockResolvedValue([
      {
        patient: {
          id: 'p1',
          name: 'Ramesh Patil',
          phoneE164: '+919876543210',
          age: 42,
          gender: 'M',
          mrn: 'QR-2026-00042',
          qid: 'QID-8K4M-2P7R',
          address: 'Pune',
        },
        tier: 'exact',
        score: 100,
        reasons: ['same_phone_exact_name'],
        isFamilyPhone: false,
        isProbableDuplicate: true,
      },
    ]);

    const res = await findPatientDuplicatesDynamic({ phone: '9876543210', name: 'Ramesh Patil' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0].patient.mrn).toBe('QR-2026-00042');
      expect(res.matches[0].tier).toBe('exact');
    }
  });

  it('rejects mergePatientsDynamic when user lacks permissions', async () => {
    vi.spyOn(authModule, 'requireWritableSession').mockResolvedValue({
      userId: 'user-nurse',
      hospitalId: 'hospital-1',
      role: 'nurse', // Nurse cannot merge
    } as any);

    const res = await mergePatientsDynamic({ fromPatientId: 'p1', toPatientId: 'p2' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/permission/i);
    }
  });

  it('executes merge successfully for receptionist with justification', async () => {
    vi.spyOn(authModule, 'requireWritableSession').mockResolvedValue({
      userId: 'user-desk',
      hospitalId: 'hospital-1',
      role: 'receptionist',
    } as any);

    vi.spyOn(mergeService, 'executePatientMerge').mockResolvedValue({
      survivorId: 'p2',
      alertId: 'alert-1',
    });

    const res = await mergePatientsDynamic({
      fromPatientId: 'p1',
      toPatientId: 'p2',
      justification: 'Accidental duplicate registered yesterday with typo in name',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.survivorId).toBe('p2');
      expect(res.alertId).toBe('alert-1');
    }
  });
});
