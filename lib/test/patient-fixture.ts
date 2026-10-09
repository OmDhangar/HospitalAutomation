import type postgres from 'postgres';
import { generateQid } from '@/lib/domain/uhid';

/**
 * A patient row for an integration-test fixture written straight to the
 * database on the admin connection, with the identity every patient carries
 * since 0039 (a person, a QID and an MRN) — required once 0040 applies.
 * Services create patients through resolvePatientInTx; this is only for
 * fixtures that need a row without going through one.
 */
export async function insertFixturePatient(
  admin: postgres.Sql,
  row: { id?: string; hospitalId: string; phoneE164: string; name: string },
): Promise<string> {
  const [person] = await admin`
    insert into persons (qid, identity_name, created_by_hospital_id)
    values (${generateQid()}, ${row.name}, ${row.hospitalId})
    returning id, qid`;
  const [patient] = await admin`
    insert into patients (id, hospital_id, phone_e164, name, person_id, qid, mrn, person_link_method)
    values (${row.id ?? crypto.randomUUID()}, ${row.hospitalId}, ${row.phoneE164}, ${row.name},
            ${person.id}, ${person.qid}, ${'T' + crypto.randomUUID().slice(0, 12)}, 'registered_here')
    returning id`;
  return patient.id as string;
}
