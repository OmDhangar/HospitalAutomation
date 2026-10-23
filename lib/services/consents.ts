import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { consentTemplates, patientConsents } from '@/lib/db/schema';

export function computeConsentHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function formatConsentText(
  template: string,
  variables: Record<string, string | number | null | undefined>,
): string {
  let result = template;
  for (const [key, val] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(pattern, val != null ? String(val) : '');
  }
  // Remove any remaining unresolved placeholders
  result = result.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '');
  return result.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').trim();
}

export type RecordConsentArgs = {
  hospitalId: string;
  admissionId: string;
  patientId: string;
  templateCode: string;
  templateTitle: string;
  templateBody: string;
  language?: 'en' | 'mr' | 'hi';
  status?: 'pending' | 'obtained' | 'refused' | 'revoked';
  signatoryCapacity?: 'patient' | 'relative' | 'guardian' | 'legal_rep';
  signatoryName?: string | null;
  signatoryRelation?: string | null;
  signatoryPhone?: string | null;
  doctorExplainedId?: string | null;
  witnessStaffUserId?: string | null;
  paperFormFiled?: boolean;
  variables?: Record<string, string | number | null | undefined>;
};

export async function recordConsentInTx(
  tx: Tx,
  args: RecordConsentArgs,
): Promise<{ consentId: string; hash: string }> {
  const renderedText = args.variables
    ? formatConsentText(args.templateBody, args.variables)
    : args.templateBody.trim();
  const hash = computeConsentHash(renderedText);
  const now = new Date();

  // Find active template ID if registered
  const [template] = await tx
    .select({ id: consentTemplates.id, version: consentTemplates.version })
    .from(consentTemplates)
    .where(
      and(
        eq(consentTemplates.hospitalId, args.hospitalId),
        eq(consentTemplates.code, args.templateCode),
        eq(consentTemplates.isActive, true),
      ),
    )
    .limit(1);

  const [inserted] = await tx
    .insert(patientConsents)
    .values({
      hospitalId: args.hospitalId,
      admissionId: args.admissionId,
      patientId: args.patientId,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? 1,
      textSnapshot: renderedText,
      textHashSha256: hash,
      language: args.language ?? 'mr',
      status: args.status ?? 'pending',
      signatoryCapacity: args.signatoryCapacity ?? (args.signatoryRelation && args.signatoryRelation !== 'Self' ? 'relative' : 'patient'),
      signatoryNameSnapshot: args.signatoryName?.trim() || 'Self',
      signatoryRelationSnapshot: args.signatoryRelation?.trim() || 'Self',
      signatoryPhoneSnapshot: args.signatoryPhone?.trim() || null,
      method: 'paper',
      paperOnFile: args.paperFormFiled ?? (args.status === 'obtained'),
      explainedByDoctorId: args.doctorExplainedId ?? null,
      witnessStaffUserId: args.witnessStaffUserId ?? null,
      signedAt: args.status === 'obtained' ? now : now,
      createdAt: now,
    })
    .returning({ id: patientConsents.id });

  return { consentId: inserted.id, hash };
}
