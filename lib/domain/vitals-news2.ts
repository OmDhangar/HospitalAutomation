/**
 * Royal College of Physicians National Early Warning Score (NEWS2)
 * Thresholds and physiological scoring logic for inpatient clinical escalation.
 */

export interface VitalsInputForNews2 {
  respiratoryRate?: number | null;
  spo2Percent?: number | null;
  o2Support?: string | null; // 'RA' (Room Air) or supplemental oxygen like 'NC', 'Mask', 'NIV', 'Trach'
  bpSystolic?: number | null;
  pulseBpm?: number | null;
  avpu?: 'A' | 'V' | 'P' | 'U' | null;
  temperatureF?: number | null; // in Fahrenheit
}

export interface News2ScoreResult {
  respiratoryRateScore: number;
  spo2Score: number;
  o2SupportScore: number;
  systolicBpScore: number;
  pulseScore: number;
  avpuScore: number;
  tempScore: number;
  totalScore: number;
  hasSingleParameterThree: boolean;
  isEscalated: boolean;
  riskBand: 'low' | 'low_medium' | 'medium' | 'high';
}

export function isNews2Escalated(totalScore: number, hasSingleParameterThree = false): boolean {
  return totalScore >= 5 || hasSingleParameterThree;
}

export function calculateNews2(v: VitalsInputForNews2): News2ScoreResult {
  // 1. Respiration Rate (breaths/min)
  let respiratoryRateScore = 0;
  if (v.respiratoryRate != null) {
    if (v.respiratoryRate <= 8) respiratoryRateScore = 3;
    else if (v.respiratoryRate <= 11) respiratoryRateScore = 1;
    else if (v.respiratoryRate <= 20) respiratoryRateScore = 0;
    else if (v.respiratoryRate <= 24) respiratoryRateScore = 2;
    else respiratoryRateScore = 3;
  }

  // 2. SpO2 (%) - Scale 1 (standard)
  let spo2Score = 0;
  if (v.spo2Percent != null) {
    if (v.spo2Percent <= 91) spo2Score = 3;
    else if (v.spo2Percent <= 93) spo2Score = 2;
    else if (v.spo2Percent <= 95) spo2Score = 1;
    else spo2Score = 0;
  }

  // 3. Supplemental Oxygen
  let o2SupportScore = 0;
  if (v.o2Support && v.o2Support.toUpperCase() !== 'RA' && v.o2Support.toUpperCase() !== 'ROOM AIR') {
    o2SupportScore = 2;
  }

  // 4. Systolic Blood Pressure (mmHg)
  let systolicBpScore = 0;
  if (v.bpSystolic != null) {
    if (v.bpSystolic <= 90) systolicBpScore = 3;
    else if (v.bpSystolic <= 100) systolicBpScore = 2;
    else if (v.bpSystolic <= 110) systolicBpScore = 1;
    else if (v.bpSystolic <= 219) systolicBpScore = 0;
    else systolicBpScore = 3;
  }

  // 5. Pulse (bpm)
  let pulseScore = 0;
  if (v.pulseBpm != null) {
    if (v.pulseBpm <= 40) pulseScore = 3;
    else if (v.pulseBpm <= 50) pulseScore = 1;
    else if (v.pulseBpm <= 90) pulseScore = 0;
    else if (v.pulseBpm <= 110) pulseScore = 1;
    else if (v.pulseBpm <= 130) pulseScore = 2;
    else pulseScore = 3;
  }

  // 6. Consciousness (AVPU)
  let avpuScore = 0;
  if (v.avpu && v.avpu !== 'A') {
    avpuScore = 3;
  }

  // 7. Temperature (°F)
  // <= 95.0F: 3, 95.1-96.8F: 1, 96.9-100.4F: 0, 100.5-102.2F: 1, >= 102.3F: 2
  let tempScore = 0;
  if (v.temperatureF != null) {
    if (v.temperatureF <= 95.0) tempScore = 3;
    else if (v.temperatureF <= 96.8) tempScore = 1;
    else if (v.temperatureF <= 100.4) tempScore = 0;
    else if (v.temperatureF <= 102.2) tempScore = 1;
    else tempScore = 2;
  }

  const scores = [
    respiratoryRateScore,
    spo2Score,
    o2SupportScore,
    systolicBpScore,
    pulseScore,
    avpuScore,
    tempScore,
  ];

  const totalScore = scores.reduce((sum, s) => sum + s, 0);
  const hasSingleParameterThree = scores.some((s) => s === 3);
  const isEscalated = totalScore >= 5 || hasSingleParameterThree;

  let riskBand: News2ScoreResult['riskBand'] = 'low';
  if (totalScore >= 7) riskBand = 'high';
  else if (totalScore >= 5 || hasSingleParameterThree) riskBand = 'medium';
  else if (totalScore >= 1) riskBand = 'low_medium';

  return {
    respiratoryRateScore,
    spo2Score,
    o2SupportScore,
    systolicBpScore,
    pulseScore,
    avpuScore,
    tempScore,
    totalScore,
    hasSingleParameterThree,
    isEscalated,
    riskBand,
  };
}
