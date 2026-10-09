import 'dotenv/config';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { closeAdminDb, getAdminDb } from '@/lib/db/admin';
import { hospitals, patients, persons } from '@/lib/db/schema';
import { birthYearFromAge } from '@/lib/domain/patient-match';
import { generateQid } from '@/lib/domain/uhid';
import { nextMrnInTx } from '@/lib/services/patients';

/**
 * Gives every patient row created before 0039 its person, QID and MRN.
 *
 *   npx tsx scripts/backfill-patient-identity.ts --dry-run   # count only
 *   npx tsx scripts/backfill-patient-identity.ts             # do it
 *
 * Run after 0039 and the code that uses it are deployed, and before 0040,
 * which refuses to apply while any row is still missing an identity.
 *
 * - One new person per row: nothing is merged, within a hospital or across
 *   hospitals. Duplicates are for staff to merge later, under audit.
 * - MRNs are issued per hospital in registration order (oldest row first),
 *   from the hospital's configured prefix and start. Set those first if the
 *   hospital wants them.
 * - Idempotent and resumable: only rows without a person are touched, in
 *   transactions of BATCH rows, so a failure loses at most one batch.
 * - Runs on the admin connection. The QID check and the name key are still
 *   enforced by the database; nothing here can write an invalid QID.
 */
const BATCH = 500;
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const db = getAdminDb();
  const missing = await db
    .select({ hospitalId: patients.hospitalId, count: sql<number>`count(*)::int` })
    .from(patients)
    .where(isNull(patients.personId))
    .groupBy(patients.hospitalId);
  const total = missing.reduce((sum, row) => sum + row.count, 0);
  console.log(`${total} patient rows without an identity, in ${missing.length} hospitals`);
  if (dryRun || total === 0) return;

  const now = new Date();
  for (const { hospitalId, count } of missing) {
    const [hospital] = await db.select({ name: hospitals.name }).from(hospitals).where(eq(hospitals.id, hospitalId));
    let done = 0;
    for (;;) {
      const batch = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: patients.id, name: patients.name, gender: patients.gender, age: patients.age, mrn: patients.mrn })
          .from(patients)
          .where(and(eq(patients.hospitalId, hospitalId), isNull(patients.personId)))
          .orderBy(asc(patients.createdAt), asc(patients.id))
          .limit(BATCH)
          .for('update', { skipLocked: true });

        for (const row of rows) {
          const birthYear = birthYearFromAge(row.age, now);
          let person: { id: string; qid: string } | undefined;
          for (let attempt = 0; !person; attempt++) {
            const qid = generateQid();
            try {
              // A savepoint, so a QID collision (one in billions) retries without losing the batch.
              [person] = await tx.transaction((sp) =>
                sp
                  .insert(persons)
                  .values({
                    qid,
                    identityName: row.name.trim(),
                    identityGender: row.gender,
                    identityBirthYear: birthYear,
                    createdByHospitalId: hospitalId,
                  })
                  .returning({ id: persons.id, qid: persons.qid }),
              );
            } catch (error) {
              const code = (error as { code?: string; cause?: { code?: string } }).code ??
                (error as { cause?: { code?: string } }).cause?.code;
              if (code !== '23505' || attempt >= 3) throw error;
            }
          }
          await tx
            .update(patients)
            .set({
              personId: person.id,
              qid: person.qid,
              mrn: row.mrn ?? (await nextMrnInTx(tx, hospitalId)),
              birthYear,
              personLinkMethod: 'registered_here',
              personLinkedAt: now,
            })
            .where(eq(patients.id, row.id));
        }
        return rows.length;
      });
      done += batch;
      if (batch > 0) console.log(`  ${hospital?.name ?? hospitalId}: ${done}/${count}`);
      if (batch < BATCH) break;
    }
  }

  const [left] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(patients)
    .where(isNull(patients.personId));
  console.log(left.count === 0 ? 'done: every patient row has an identity; 0040 can be applied' : `${left.count} rows still missing (rerun)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeAdminDb());
