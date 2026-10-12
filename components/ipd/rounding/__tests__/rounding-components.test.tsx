import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { VitalsFreshnessBar } from '../vitals-freshness-bar';
import { AllergyBanner } from '../allergy-banner';
import { ActiveOrdersReview } from '../active-orders-review';
import type { SelectIpdMedicationOrder } from '@/lib/db/schema';

describe('Doctor Rounding Cockpit UI Components', () => {
  describe('VitalsFreshnessBar', () => {
    it('renders empty alert when no vitals have been collected', () => {
      const html = renderToString(
        <VitalsFreshnessBar
          admissionId="adm-1"
          vitals={{
            reading: null,
            ageMinutes: null,
            isStale: false,
          }}
        />,
      );

      expect(html).toContain('No TPR vitals recorded yet');
      expect(html).toContain('/ipd/admissions/adm-1/tpr');
    });

    it('renders metrics and stale indicator when vitals are older than 6 hours', () => {
      const html = renderToString(
        <VitalsFreshnessBar
          admissionId="adm-1"
          vitals={{
            reading: {
              temperatureF: 101.4,
              pulseBpm: 110,
              spo2Percent: 93,
              bpSystolic: 155,
              bpDiastolic: 95,
              respiratoryRate: 24,
              bloodSugarMgDl: 210,
              collectedAt: new Date(Date.now() - 400 * 60000),
            },
            ageMinutes: 400,
            isStale: true,
          }}
        />,
      );

      expect(html).toContain('Over 6 hours old');
      expect(html).toContain('110'); // pulse
      expect(html).toContain('Tachycardia');
      expect(html).toContain('155/95'); // BP
      expect(html).toContain('High');
      expect(html).toContain('93%'); // SpO2
      expect(html).toContain('Hypoxic');
      expect(html).toContain('101.4°'); // Temp
      expect(html).toContain('Febrile');
    });
  });

  describe('AllergyBanner', () => {
    it('renders warning alert when unreviewed', () => {
      const html = renderToString(
        <AllergyBanner
          admissionId="adm-1"
          assessment={{
            status: 'unreviewed',
            allergens: [],
            reviewedAt: null,
          }}
        />,
      );

      expect(html).toContain('Allergy Assessment Required');
      expect(html).toContain('1-Tap NKDA');
    });

    it('renders green confirmation when NKDA', () => {
      const html = renderToString(
        <AllergyBanner
          admissionId="adm-1"
          assessment={{
            status: 'nkda',
            allergens: [],
            reviewedAt: new Date(),
            reviewedByUserName: 'Dr. House',
          }}
        />,
      );

      expect(html).toContain('No Known Drug Allergies (NKDA)');
      expect(html).toContain('Dr. House');
    });

    it('renders red warning with allergens when documented', () => {
      const html = renderToString(
        <AllergyBanner
          admissionId="adm-1"
          assessment={{
            status: 'allergies_documented',
            allergens: [
              { substance: 'Amoxicillin', reaction: 'Anaphylaxis', severity: 'severe' },
              { substance: 'Ibuprofen', reaction: 'Gastric pain', severity: 'mild' },
            ],
            reviewedAt: new Date(),
            reviewedByUserName: 'Dr. House',
          }}
        />,
      );

      expect(html).toContain('Documented Drug Allergies');
      expect(html).toContain('Amoxicillin');
      expect(html).toContain('Anaphylaxis');
      expect(html).toContain('severe');
      expect(html).toContain('Ibuprofen');
    });
  });

  describe('ActiveOrdersReview', () => {
    const mockOrder: SelectIpdMedicationOrder = {
      id: 'ord-1',
      hospitalId: 'hosp-1',
      admissionId: 'adm-1',
      encounterId: 'enc-1',
      patientId: 'pat-1',
      orderChainId: 'chain-1',
      version: 1,
      supersedesOrderId: null,
      medicineId: 'med-1',
      medicineName: 'Ceftriaxone 1g IV',
      genericName: 'Ceftriaxone',
      form: 'injection',
      strength: '1g',
      doseAmount: '1',
      doseUnit: 'g',
      route: 'iv_push',
      scheduleType: 'scheduled',
      frequencyCode: 'BD',
      scheduleTimes: ['08:00', '20:00'],
      isPrn: false,
      prnIndication: null,
      prnMaxDailyDoses: null,
      prnMaxDailyQuantity: null,
      prnMaxDailyUnit: null,
      prnMinIntervalHours: null,
      specialInstructions: 'Slow IV push over 5 minutes',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86400000 * 2),
      durationDays: 3,
      status: 'active',
      statusReason: null,
      statusChangedAt: new Date(),
      statusChangedByUserId: 'usr-1',
      signedAt: new Date(),
      signedByDoctorId: 'doc-1',
      signedByUserId: 'usr-1',
      supersededAt: null,
      discontinuedAt: null,
      discontinuedByUserId: null,
      discontinueReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('renders empty message when no active orders exist', () => {
      const html = renderToString(
        <ActiveOrdersReview
          activeOrders={[]}
          recentAdministrations={[]}
          resolutions={{}}
          onChangeResolution={() => {}}
        />,
      );

      expect(html).toContain('No active medication orders');
    });

    it('renders active orders with decision options and administration history', () => {
      const html = renderToString(
        <ActiveOrdersReview
          activeOrders={[mockOrder]}
          recentAdministrations={[
            {
              id: 'adm-1',
              orderId: 'ord-1',
              orderChainId: 'chain-1',
              doseGiven: '1g',
              actualTime: new Date(Date.now() - 3600000),
              recordedAt: new Date(Date.now() - 3600000),
              outcome: 'given',
            },
          ]}
          resolutions={{
            'ord-1': { type: 'continue', orderId: 'ord-1' },
          }}
          onChangeResolution={() => {}}
        />,
      );

      expect(html).toContain('Ceftriaxone 1g IV');
      expect(html).toContain('BD');
      expect(html).toContain('Slow IV push over 5 minutes');
      expect(html).toContain('Last given:');
      expect(html).toContain('Continue');
      expect(html).toContain('Renew');
      expect(html).toContain('Modify');
      expect(html).toContain('Hold');
      expect(html).toContain('Discontinue');
    });
  });
});
