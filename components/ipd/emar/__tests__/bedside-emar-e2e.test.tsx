import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BedsideEmar } from '../bedside-emar';
import type { BedsideEmarView } from '@/lib/services/ipd-emar';
import type { SelectIpdMedicationOrder, SelectIpdMedicationAdministration } from '@/lib/db/schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/app/(app)/ipd/actions', () => ({
  recordAdministrationAction: vi.fn().mockResolvedValue({ ok: true, administrationId: 'adm-rec-1' }),
  recordExceptionAction: vi.fn().mockResolvedValue({ ok: true, administrationId: 'adm-rec-2' }),
  voidAdministrationAction: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('BedsideEmar Orchestrator Component', () => {
  const dummyEmarData: BedsideEmarView = {
    dueNow: [
      {
        orderId: 'ord-101',
        orderChainId: 'chain-101',
        medicineId: 'med-101',
        medicineName: 'Amoxicillin 500mg Capsule',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled',
        scheduledTime: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago -> dueNow
        status: 'dueNow',
      },
    ],
    overdue: [
      {
        orderId: 'ord-102',
        orderChainId: 'chain-102',
        medicineId: 'med-102',
        medicineName: 'Ceftriaxone 1g IV',
        doseAmount: '1',
        doseUnit: 'g',
        route: 'iv_push',
        scheduleType: 'scheduled',
        scheduledTime: new Date(Date.now() - 90 * 60 * 1000), // 90 min ago -> overdue
        status: 'overdue',
      },
    ],
    upcoming: [
      {
        orderId: 'ord-103',
        orderChainId: 'chain-103',
        medicineId: 'med-103',
        medicineName: 'Pantoprazole 40mg Tab',
        doseAmount: '40',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled',
        scheduledTime: new Date(Date.now() + 180 * 60 * 1000), // in 3 hours
        status: 'upcoming',
      },
    ],
    prn: [
      {
        orderId: 'ord-104',
        orderChainId: 'chain-104',
        medicineId: 'med-104',
        medicineName: 'Paracetamol 500mg SOS',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        prnIndication: 'Fever above 100.5F or severe body ache',
        prnMinIntervalHours: 4,
        prnMaxDailyDoses: 4,
        eligibility: {
          eligible: true,
          dosesRemainingToday: 3,
        },
      },
    ],
    onHold: [
      {
        id: 'ord-105',
        orderChainId: 'chain-105',
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        medicineId: 'med-105',
        medicineName: 'Warfarin 2.5mg Tab',
        doseAmount: '2.5',
        doseUnit: 'mg',
        route: 'oral',
        status: 'on_hold',
        holdReason: 'INR elevated (4.2); hold until repeat PT/INR',
        instructions: 'Take in evening after food',
      } as unknown as SelectIpdMedicationOrder,
    ],
    recentHistory: [
      {
        id: 'admin-101',
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        orderId: 'ord-101',
        orderChainId: 'chain-101',
        scheduledTime: new Date(Date.now() - 480 * 60 * 1000),
        actualTime: new Date(Date.now() - 475 * 60 * 1000),
        doseGiven: '500 mg',
        routeGiven: 'oral',
        outcome: 'administered',
        recordedChannel: 'ward_device',
        administeringUserId: 'nurse-1',
        recordedAt: new Date(Date.now() - 475 * 60 * 1000),
        clinicalNote: 'Tolerated well with water',
        voidedAt: null,
      } as unknown as SelectIpdMedicationAdministration,
    ],
  };

  it('renders patient banner with allergies and correct bucket counts', () => {
    const html = renderToString(
      <BedsideEmar
        admissionId="adm-1"
        patientName="Sunita Sharma"
        ipdNumber="IPD-2026-0042"
        bedLabel="B-201"
        wardName="Female Medical Ward"
        data={dummyEmarData}
        allergyStatus="allergies_documented"
        allergies={[{ substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' }]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('Sunita Sharma');
    expect(html).toContain('IPD-2026-0042');
    expect(html).toContain('B-201');
    expect(html).toContain('Female Medical Ward');
    expect(html).toContain('Penicillin');
    expect(html).toContain('(severe)');
    expect(html).toContain('Due Now');
    expect(html).toContain('Overdue');
    expect(html).toContain('Upcoming');
    expect(html).toContain('PRN / SOS');
    expect(html).toContain('On Hold');
    expect(html).toContain('Recent 24h');
  });

  it('renders default active dueNow card with dose and route', () => {
    const html = renderToString(
      <BedsideEmar
        admissionId="adm-1"
        patientName="Sunita Sharma"
        bedLabel="B-201"
        data={dummyEmarData}
        canAdminister={true}
      />,
    );

    expect(html).toContain('Amoxicillin 500mg Capsule');
    expect(html).toContain('oral');
    expect(html).toContain('Administer Dose');
    expect(html).toContain('Withhold / Omit');
  });

  it('renders unreviewed allergy banner when status is unreviewed', () => {
    const html = renderToString(
      <BedsideEmar
        admissionId="adm-1"
        patientName="Amit Patel"
        data={{
          ...dummyEmarData,
          dueNow: [],
        }}
        allergyStatus="unreviewed"
        canAdminister={true}
      />,
    );

    expect(html).toContain('Amit Patel');
    expect(html).toContain('Allergies Unreviewed');
  });

  it('renders NKDA badge when status is nkda', () => {
    const html = renderToString(
      <BedsideEmar
        admissionId="adm-1"
        patientName="Kavita Rao"
        data={{
          ...dummyEmarData,
          dueNow: [],
        }}
        allergyStatus="nkda"
        canAdminister={true}
      />,
    );

    expect(html).toContain('Kavita Rao');
    expect(html).toContain('NKDA');
  });
});
