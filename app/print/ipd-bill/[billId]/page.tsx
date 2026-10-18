import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { categorizeBillLines, computeReceiptSummary, formatBeddingInfo } from '@/lib/domain/bill-receipt';
import { getBillForPrint } from '@/lib/services/discharge-billing';
import { getLetterheadSettings } from '@/lib/services/letterhead';
import { getMedicalReportForPrint } from '@/lib/services/medical-report';
import { IpdBillPrintView } from '@/components/print/ipd-bill-print-view';

export const metadata = { title: 'Patient Bill & Medical Report' };

interface IpdBillPrintPageProps {
  params: Promise<{ billId: string }>;
  searchParams: Promise<{
    admissionId?: string;
    report?: string;
    print?: string;
  }>;
}

export default async function IpdBillPrintPage({
  params,
  searchParams,
}: IpdBillPrintPageProps) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');
  if (
    !can(session.role, 'ipd.discharge') &&
    !can(session.role, 'billing.collect')
  ) {
    notFound();
  }

  const { billId } = await params;
  const query = await searchParams;

  const [bill, letterheadSettings] = await Promise.all([
    getBillForPrint({
      hospitalId: session.hospitalId,
      billId,
      admissionId: query.admissionId,
      actorUserId: session.userId,
    }),
    getLetterheadSettings(session.hospitalId),
  ]);

  if (!bill) notFound();

  const medicalReport = await getMedicalReportForPrint(session.hospitalId, bill.admission.id);

  const tz = bill.timezone;
  const formatDate = (at: Date | null) =>
    at
      ? at.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: tz,
        })
      : '—';

  const formatTime = (at: Date | null) =>
    at
      ? at.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
          timeZone: tz,
        })
      : '—';

  const isFinal = bill.bill.status === 'final';
  const bedding = formatBeddingInfo({
    wardName: bill.admission.bed?.wardName,
    bedLabel: bill.admission.bed?.label,
  });
  const groups = categorizeBillLines(bill.lines, tz, bedding);
  const summary = computeReceiptSummary(bill.totals, bill.payments);

  // Match attending doctor in letterhead settings for qualification and registration number
  const matchedDoctor = letterheadSettings.doctors.find(
    (d) =>
      d.name.toLowerCase().includes(bill.admission.doctorName.toLowerCase()) ||
      bill.admission.doctorName.toLowerCase().includes(d.name.toLowerCase()),
  ) ?? letterheadSettings.doctors[0];

  const doctorStamp = {
    name: bill.admission.doctorName || matchedDoctor?.name || 'DR. VINOD RAJESH PAWARA',
    qualification: matchedDoctor?.qualification || 'MBBS, MD-MEDICINE',
    designation: 'CONSULTANT PHYSICIAN',
    registrationNo: matchedDoctor?.registrationNo || '2015074070',
  };

  const patient = {
    name: bill.patient.name,
    age: bill.patient.age,
    gender: bill.patient.gender,
    address: bill.patient.address,
    location: bill.hospital.branchName || 'SHIRPUR',
    phone: bill.patient.phone,
    patientId: bill.patient.mrn || bill.patient.id.slice(0, 8).toUpperCase(),
    roomType: bedding.roomType,
    bedNumber: bedding.bedNumber,
    roomBed: bill.admission.bed ? bedding.display : null,
    doctorName: bill.admission.doctorName,
    department: 'MEDICINE',
  };

  const billMetadata = {
    billNumber: bill.bill.billNumber ? `#${bill.bill.billNumber}` : '#6097 (Draft)',
    billDate: isFinal ? formatDate(bill.bill.finalizedAt) : formatDate(new Date()),
    ipdNumber: bill.admission.ipdNumber ? String(bill.admission.ipdNumber) : bill.admission.id.slice(0, 8).toUpperCase(),
    admissionDate: formatDate(bill.admission.admittedAt),
    admissionTime: formatTime(bill.admission.admittedAt),
    dischargeDate: isFinal ? formatDate(bill.admission.dischargedAt) : 'Currently Admitted',
    dischargeTime: isFinal ? formatTime(bill.admission.dischargedAt) : 'Inpatient',
  };

  const backHref = `/ipd/patients/${bill.admission.id}/billing`;

  return (
    <IpdBillPrintView
      hospitalName={letterheadSettings.hospitalName || 'GURUVED HOSPITAL & CRITICARE CENTRE'}
      registrationNo={letterheadSettings.registrationNo || 'GHD/BNH/136/2022'}
      isFinal={isFinal}
      patient={patient}
      bill={billMetadata}
      doctorStamp={doctorStamp}
      groups={groups}
      summary={summary}
      medicalReport={medicalReport}
      defaultIncludeReport={query.report === '1'}
      autoPrint={query.print !== '0'}
      backHref={backHref}
    />
  );
}
