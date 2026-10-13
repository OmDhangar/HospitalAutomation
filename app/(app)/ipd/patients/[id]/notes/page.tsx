import React from 'react';
import { notFound } from 'next/navigation';
import { desc, eq, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { withTenant, type Tx } from '@/lib/db';
import { clinicalAuditLogs, users, ipdClinicalRounds, doctors } from '@/lib/db/schema';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { NotesTab, type ClinicalNoteItem } from '@/components/ipd/notes/notes-tab';

export const metadata = { title: 'Clinical Notes · IPD' };

export default async function PatientNotesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  const notes = await withTenant(
    session.hospitalId,
    async (tx: Tx) => {
      // 1. Fetch from clinicalAuditLogs where tableName = 'clinical_notes'
      const auditNotes = await tx
        .select({
          id: clinicalAuditLogs.id,
          admissionId: clinicalAuditLogs.recordId,
          newValue: clinicalAuditLogs.newValue,
          reason: clinicalAuditLogs.reason,
          createdAt: clinicalAuditLogs.createdAt,
          authorName: users.name,
        })
        .from(clinicalAuditLogs)
        .leftJoin(users, eq(users.id, clinicalAuditLogs.userId))
        .where(
          and(
            eq(clinicalAuditLogs.hospitalId, session.hospitalId),
            eq(clinicalAuditLogs.tableName, 'clinical_notes'),
            eq(clinicalAuditLogs.recordId, id),
          ),
        )
        .orderBy(desc(clinicalAuditLogs.createdAt));

      // 2. Fetch from ipdClinicalRounds
      const doctorRounds = await tx
        .select({
          id: ipdClinicalRounds.id,
          admissionId: ipdClinicalRounds.admissionId,
          evaluationNotes: ipdClinicalRounds.evaluationNotes,
          status: ipdClinicalRounds.status,
          signedAt: ipdClinicalRounds.signedAt,
          createdAt: ipdClinicalRounds.createdAt,
          doctorName: doctors.name,
        })
        .from(ipdClinicalRounds)
        .leftJoin(doctors, eq(doctors.id, ipdClinicalRounds.doctorId))
        .where(
          and(
            eq(ipdClinicalRounds.hospitalId, session.hospitalId),
            eq(ipdClinicalRounds.admissionId, id),
          ),
        )
        .orderBy(desc(ipdClinicalRounds.createdAt));

      const items: ClinicalNoteItem[] = [];

      for (const row of auditNotes) {
        const val = (row.newValue || {}) as any;
        const nType = val.noteType || 'NURSING';
        items.push({
          id: row.id,
          admissionId: row.admissionId,
          noteType: nType,
          authorName: row.authorName || undefined,
          authorRole: nType === 'SOAP' ? 'doctor' : 'nurse',
          createdAt: new Date(row.createdAt),
          soapS: val.soapS,
          soapO: val.soapO,
          soapA: val.soapA,
          soapP: val.soapP,
          body: val.body,
        });
      }

      for (const r of doctorRounds) {
        items.push({
          id: r.id,
          admissionId: r.admissionId,
          noteType: 'SOAP',
          authorName: r.doctorName || undefined,
          authorRole: 'doctor',
          createdAt: new Date(r.signedAt || r.createdAt),
          body: r.evaluationNotes,
        });
      }

      items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return items;
    },
    { clinical: true },
  );

  return (
    <NotesTab
      admissionId={id}
      notes={notes}
      canAddNote={!session.readOnly}
    />
  );
}
