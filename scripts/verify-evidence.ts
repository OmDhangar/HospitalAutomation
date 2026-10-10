import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { closeAdminDb, getAdminDb } from '@/lib/db/admin';
import { PROBLEM_TEXT } from '@/lib/domain/evidence';
import { DirectoryAnchor, configuredAnchor } from '@/lib/services/evidence-anchor';
import { verifyEvidence } from '@/lib/services/evidence';

/**
 * Checks the evidence log from the first seal (IPD sheets plan §7.6), outside
 * the app: every seal's chain, hash, signature and outside copy, and every
 * event rebuilt from its columns. Exit code 1 if anything is wrong.
 *
 *   npx tsx scripts/verify-evidence.ts --hospital <uuid>
 *   npx tsx scripts/verify-evidence.ts --all
 *   ... --anchors <dir>        compare with these outside copies (default EVIDENCE_ANCHOR_DIR)
 *   ... --no-record            do not write the result to acct_verifications
 *
 * Needs DATABASE_ADMIN_URL, and EVIDENCE_PUBLIC_KEY to check signatures.
 */
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? null);
  };
  const anchorsDir = value('--anchors');
  const anchor = anchorsDir ? new DirectoryAnchor(anchorsDir) : configuredAnchor();
  const record = !args.includes('--no-record');

  let hospitals: string[];
  if (args.includes('--all')) {
    const rows = (await getAdminDb().execute(sql`select distinct hospital_id::text as id from acct_digests order by 1`)) as unknown as {
      id: string;
    }[];
    hospitals = rows.map((r) => r.id);
  } else {
    const one = value('--hospital');
    if (!one || !/^[0-9a-f-]{36}$/i.test(one)) {
      console.error('Usage: verify-evidence --hospital <uuid> | --all [--anchors <dir>] [--no-record]');
      process.exit(2);
    }
    hospitals = [one];
  }

  let failed = 0;
  for (const hospitalId of hospitals) {
    const result = await verifyEvidence({ hospitalId, source: 'cli', full: true, anchor, record });
    const line = `${hospitalId}  ${result.ok ? 'OK ' : 'FAIL'}  seals ${result.digestsChecked}, events ${result.eventsChecked}, outside copies ${result.anchorsChecked}, signatures ${result.signaturesChecked ? 'checked' : 'NOT checked (no EVIDENCE_PUBLIC_KEY)'}`;
    console.log(line);
    for (const problem of result.problems) {
      console.log(`    - ${PROBLEM_TEXT[problem.code]}${problem.digestNo ? ` (seal #${problem.digestNo})` : ''}${problem.count ? ` [${problem.count}]` : ''}`);
    }
    if (!result.ok) failed += 1;
  }
  await closeAdminDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await closeAdminDb();
  process.exit(1);
});
