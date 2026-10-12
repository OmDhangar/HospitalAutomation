import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { EmarBucketTabs } from '../emar-bucket-tabs';
import { EmarTaskCard } from '../emar-task-card';
import { EmarRecentHistory } from '../emar-recent-history';
import { AdministerModal } from '../administer-modal';
import { ExceptionModal } from '../exception-modal';
import { PrnAdminModal } from '../prn-admin-modal';
import type { BedsideDueItem, BedsidePrnItem } from '@/lib/services/ipd-emar';
import type { SelectIpdMedicationOrder, SelectIpdMedicationAdministration } from '@/lib/db/schema';

describe('Bedside eMAR Task Bucket Components', () => {
  describe('EmarBucketTabs', () => {
    it('renders all bucket tabs with correct badges and counts', () => {
      const html = renderToString(
        <EmarBucketTabs
          activeBucket="dueNow"
          onChangeBucket={() => {}}
          counts={{
            dueNow: 3,
            overdue: 1,
            upcoming: 4,
            prn: 2,
            onHold: 0,
            recentHistory: 5,
          }}
        />,
      );

      expect(html).toContain('Due Now');
      expect(html).toContain('3');
      expect(html).toContain('Overdue');
      expect(html).toContain('1');
      expect(html).toContain('Upcoming');
      expect(html).toContain('4');
      expect(html).toContain('PRN / SOS');
      expect(html).toContain('Recent 24h');
    });
  });

  describe('EmarTaskCard', () => {
    const mockDueItem: BedsideDueItem = {
      orderId: 'ord-1',
      orderChainId: 'chain-1',
      medicineId: 'med-1',
      medicineName: 'Ceftriaxone 1g IV',
      doseAmount: '1',
      doseUnit: 'g',
      route: 'iv_push',
      scheduleType: 'scheduled',
      scheduledTime: new Date(Date.now() - 3600000 * 2), // 2 hours overdue
      status: 'overdue',
      instructions: 'Give over 5 minutes slowly',
    };

    it('renders scheduled overdue task card with alert styling and action buttons', () => {
      const html = renderToString(
        <EmarTaskCard
          kind="scheduled"
          dueItem={mockDueItem}
          onAdminister={() => {}}
          onException={() => {}}
        />,
      );

      expect(html).toContain('Ceftriaxone 1g IV');
      expect(html).toContain('iv push');
      expect(html).toContain('Overdue');
      expect(html).toContain('Give over 5 minutes slowly');
      expect(html).toContain('Administer Dose');
      expect(html).toContain('Withhold / Omit');
    });

    it('renders PRN item with indication and eligibility info', () => {
      const mockPrnItem: BedsidePrnItem = {
        orderId: 'ord-2',
        orderChainId: 'chain-2',
        medicineId: 'med-2',
        medicineName: 'Paracetamol 650mg Oral',
        doseAmount: '650',
        doseUnit: 'mg',
        route: 'oral',
        prnIndication: 'For fever > 100°F or body ache',
        prnMinIntervalHours: 6,
        prnMaxDailyDoses: 4,
        eligibility: {
          eligible: true,
          dosesRemainingToday: 3,
        },
      };

      const html = renderToString(
        <EmarTaskCard
          kind="prn"
          prnItem={mockPrnItem}
          onAdminister={() => {}}
        />,
      );

      expect(html).toContain('Paracetamol 650mg Oral');
      expect(html).toContain('PRN / SOS');
      expect(html).toContain('For fever &gt; 100°F or body ache');
      expect(html).toContain('doses remaining');
      expect(html).toContain('Administer PRN');
    });

    it('renders onHold item with suspended status and instructions', () => {
      const mockHoldOrder: SelectIpdMedicationOrder = {
        id: 'ord-3',
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        encounterId: 'enc-1',
        patientId: 'pat-1',
        orderChainId: 'chain-3',
        medicineId: 'med-3',
        medicineName: 'Aspirin 75mg Oral',
        form: 'tab',
        strength: '75mg',
        doseAmount: '75',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled',
        frequencyCode: 'OD',
        scheduleTimes: ['08:00'],
        isPrn: false,
        prnIndication: null,
        prnMaxDailyDoses: null,
        prnMaxDailyQuantity: null,
        prnMaxDailyUnit: null,
        prnMinIntervalHours: null,
        specialInstructions: null,
        origin: 'inpatient_order',
        patientSupplied: false,
        startsAt: new Date(),
        endsAt: null,
        durationDays: 5,
        status: 'on_hold',
        supersedesOrderId: null,
        supersededByOrderId: null,
        orderSetId: null,
        orderSetVersion: null,
        voidedAt: null,
        voidedByUserId: null,
        voidReason: null,
        prescriberDoctorId: 'doc-1',
        createdByUserId: 'usr-1',
        signedAt: new Date(),
        roundNoteId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const html = renderToString(
        <EmarTaskCard
          kind="onHold"
          holdItem={mockHoldOrder}
        />,
      );

      expect(html).toContain('Aspirin 75mg Oral');
      expect(html).toContain('Order On Hold');
      expect(html).toContain('Suspended');
    });
  });

  describe('EmarRecentHistory', () => {
    it('renders empty alert when no recent activity', () => {
      const html = renderToString(<EmarRecentHistory history={[]} />);
      expect(html).toContain('No recent medication activity');
    });

    it('renders history items with outcomes and void button if authorized', () => {
      const mockHistory: SelectIpdMedicationAdministration[] = [
        {
          id: 'admin-1',
          hospitalId: 'hosp-1',
          admissionId: 'adm-1',
          orderId: 'ord-1',
          orderChainId: 'chain-1',
          clientId: 'client-1',
          scheduledTime: new Date(Date.now() - 3600000),
          actualTime: new Date(Date.now() - 3500000),
          decisionTime: null,
          doseAmountNumeric: '1.00',
          doseGiven: '1g',
          routeGiven: 'iv_push',
          outcome: 'administered',
          nonAdminReason: null,
          clinicalNote: 'Given in left forearm cannula',
          voidedAt: null,
          voidedByUserId: null,
          voidReason: null,
          correctsAdministrationId: null,
          correctedByAdministrationId: null,
          recordedChannel: 'ward_device',
          recordedDeviceId: 'tab-1',
          nurseUserId: 'nurse-1',
          recordedAt: new Date(Date.now() - 3500000),
          careEntryId: null,
          stockLedgerId: null,
          createdAt: new Date(),
        },
      ];

      const html = renderToString(
        <EmarRecentHistory
          history={mockHistory}
          canVoid={true}
          onVoid={async () => {}}
        />,
      );

      expect(html).toContain('1g');
      expect(html).toContain('iv push');
      expect(html).toContain('Administered');
      expect(html).toContain('Given in left forearm cannula');
      expect(html).toContain('Strike / Void');
    });
  });

  describe('AdministerModal', () => {
    it('renders verification modal with patient and medication details', () => {
      const html = renderToString(
        <AdministerModal
          isOpen={true}
          onClose={() => {}}
          admissionId="adm-1"
          dueItem={{
            orderId: 'ord-1',
            orderChainId: 'chain-1',
            medicineId: 'med-1',
            medicineName: 'Pantoprazole 40mg IV',
            doseAmount: '40',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            scheduledTime: new Date(),
            status: 'dueNow',
          }}
          patientName="Ramesh Verma"
          bedLabel="A-102"
          activeAllergies={[{ substance: 'Penicillin', severity: 'severe' }]}
          onSuccess={() => {}}
        />,
      );

      expect(html).toContain('Bedside Dose Administration Verification');
      expect(html).toContain('Ramesh Verma');
      expect(html).toContain('A-102');
      expect(html).toContain('Pantoprazole 40mg IV');
      expect(html).toContain('Confirm Dose Administered');
    });
  });

  describe('ExceptionModal', () => {
    it('renders exception options and preset structured reasons', () => {
      const html = renderToString(
        <ExceptionModal
          isOpen={true}
          onClose={() => {}}
          admissionId="adm-1"
          dueItem={{
            orderId: 'ord-1',
            orderChainId: 'chain-1',
            medicineId: 'med-1',
            medicineName: 'Metoprolol 25mg Oral',
            doseAmount: '25',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'scheduled',
            scheduledTime: new Date(),
            status: 'dueNow',
          }}
          onSuccess={() => {}}
        />,
      );

      expect(html).toContain('Record Non-Administration Exception');
      expect(html).toContain('Metoprolol 25mg Oral');
      expect(html).toContain('Omitted');
      expect(html).toContain('Held (Clinical)');
      expect(html).toContain('Refused');
      expect(html).toContain('NPO for procedure / fasting');
      expect(html).toContain('Record Exception');
    });
  });

  describe('PrnAdminModal', () => {
    it('renders PRN modal with indication and allowed dose counts', () => {
      const html = renderToString(
        <PrnAdminModal
          isOpen={true}
          onClose={() => {}}
          admissionId="adm-1"
          prnItem={{
            orderId: 'ord-2',
            orderChainId: 'chain-2',
            medicineId: 'med-2',
            medicineName: 'Ondansetron 4mg IV',
            doseAmount: '4',
            doseUnit: 'mg',
            route: 'iv_push',
            prnIndication: 'For post-chemo nausea or vomiting',
            eligibility: {
              eligible: true,
              dosesRemainingToday: 2,
            },
          }}
          patientName="Sunita Sharma"
          onSuccess={() => {}}
        />,
      );

      expect(html).toContain('Administer PRN (As Needed / SOS) Medication');
      expect(html).toContain('Ondansetron 4mg IV');
      expect(html).toContain('For post-chemo nausea or vomiting');
      expect(html).toContain('Remaining Allowed:');
      expect(html).toContain('doses today');
      expect(html).toContain('Confirm PRN Dose');
    });
  });
});
