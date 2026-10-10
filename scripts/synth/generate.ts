import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '@/lib/security/password';

/**
 * Production-sized synthetic data for load tests and migration rehearsals
 * (IPD sheets plan §2.4, phase A1).
 *
 *   npx tsx scripts/synth/generate.ts --profile tiny      # 3 hospitals, 30 days — a laptop smoke test
 *   npx tsx scripts/synth/generate.ts --profile small     # 50 hospitals, 90 days
 *   npx tsx scripts/synth/generate.ts --profile design    # 1,000 hospitals, 730 days — staging hardware only
 *
 * Writes only to a database whose name starts with `qurio_load` or is
 * `qurio_scratch`, and never with NODE_ENV=production. Every hospital it creates
 * has a `synth-` slug, so a re-run first deletes its own earlier output and
 * nothing else.
 *
 * Rows are generated inside Postgres with `generate_series` and hashes, not sent
 * from here one by one: the design profile is tens of millions of rows. Each
 * hospital is one transaction run as that tenant (`app.hospital_id`,
 * `app.clinical_access`), so the RLS policies are satisfied exactly as for the app.
 *
 * Hospital sizes are skewed like the market: 70% small (10–30 beds), 25% medium
 * (50–150), 5% large (200–500). Occupancy ≈ 85%. Stays last 1–8 days, back to
 * back per bed, so a bed is never double-booked. Each stay-day gets 4–12 bedside
 * entries (medicines, consumables, procedures).
 *
 * It also creates one owner and one nurse login per hospital, and a session for
 * each, written to `loadtest/.sessions.json` (git-ignored) for the k6 scripts.
 * Those tokens exist only in the load database.
 *
 * Tables added by later phases (chart entries, MAR, stock, events) get their own
 * steps here as those phases land.
 */

type Profile = { hospitals: number; days: number };

/** One hospital's entry in loadtest/.sessions.json. */
type LoadFixture = {
  hospital: number;
  sessions: Partial<Record<'owner' | 'nurse', string>>;
  admissions: string[];
  medicines: string[];
};
const PROFILES: Record<string, Profile> = {
  tiny: { hospitals: 3, days: 30 },
  small: { hospitals: 50, days: 90 },
  design: { hospitals: 1000, days: 730 },
};

const ALLOWED_DATABASE = /^(qurio_load[a-z0-9_]*|qurio_scratch)$/;
const SLUG_PREFIX = 'synth-';
const SESSION_DAYS = 14;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Deterministic 0..1 from a seed string, so the same profile always builds the same shape. */
function unit(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0x1_0000_0000;
}

function bedsFor(index: number): number {
  const r = unit(`size:${index}`);
  const s = unit(`beds:${index}`);
  if (r < 0.7) return 10 + Math.floor(s * 21);
  if (r < 0.95) return 50 + Math.floor(s * 101);
  return 200 + Math.floor(s * 301);
}

async function asTenant<T>(sql: Sql, hospitalId: string, work: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.hospital_id', ${hospitalId}, true),
                    set_config('app.read_only', 'false', true),
                    set_config('app.clinical_access', 'true', true)`;
    return work(tx as unknown as Sql);
  }) as Promise<T>;
}

async function buildHospital(sql: Sql, index: number, days: number, passwordHash: string) {
  const beds = bedsFor(index);
  const branchCount = beds >= 200 ? 3 : beds >= 50 ? 2 : 1;
  const wardCount = Math.max(1, Math.round(beds / 20));
  const doctorCount = Math.max(2, Math.round(beds / 10));

  const [hospital] = await sql<{ id: string }[]>`
    insert into hospitals (name, slug, timezone, default_locale, active)
    values (${`Synthetic Hospital ${index + 1}`}, ${`${SLUG_PREFIX}${index + 1}`}, 'Asia/Kolkata', 'mr', true)
    returning id`;
  const hospitalId = hospital.id;

  const fixture: LoadFixture = { hospital: index + 1, sessions: {}, admissions: [], medicines: [] };

  await asTenant(sql, hospitalId, async (tx) => {
    await tx`
      insert into branches (hospital_id, name, address)
      select ${hospitalId}, 'Branch ' || n, 'Synthetic Road ' || n from generate_series(1, ${branchCount}) n`;

    await tx`
      insert into doctors (hospital_id, branch_id, name, specialty)
      select ${hospitalId}, b.id, 'Dr Synthetic ' || n,
             (array['Medicine','Surgery','Paediatrics','OBG','Orthopaedics','ICU'])[1 + n % 6]
      from generate_series(1, ${doctorCount}) n
      join lateral (select id from branches where hospital_id = ${hospitalId}
                    order by name offset ((n - 1) % ${branchCount}) limit 1) b on true`;

    // Catalogue: one room charge per ward, plus the bedside items nurses tap.
    await tx`
      insert into charge_items (hospital_id, kind, name, unit, selling_price_paise, is_test)
      select ${hospitalId}, kind::charge_item_kind, name, unit, price, is_test
      from (values
        ('room', 'General ward per day', 'day', 80000, false),
        ('room', 'Special room per day', 'day', 150000, false),
        ('room', 'ICU per day', 'day', 400000, false),
        ('consumable', 'Syringe 5 ml', 'unit', 1000, false),
        ('consumable', 'IV set', 'unit', 12000, false),
        ('consumable', 'IV cannula 20G', 'unit', 9000, false),
        ('consumable', 'Gloves', 'pair', 1500, false),
        ('procedure', 'Nebulisation', 'unit', 15000, false),
        ('procedure', 'Dressing small', 'unit', 20000, false),
        ('service', 'Nursing charge', 'day', 30000, false),
        ('service', 'Doctor visit', 'unit', 50000, false),
        ('service', 'CBC', 'unit', 30000, true),
        ('service', 'ECG', 'unit', 20000, true)
      ) as v(kind, name, unit, price, is_test)`;

    await tx`
      insert into medicines (hospital_id, name, generic_name, strength, form, unit, selling_price_paise)
      select ${hospitalId}, name, name, strength, form, 'unit', price
      from (values
        ('Inj. Ceftriaxone', '1 g', 'injection', 6000),
        ('Inj. Pantoprazole', '40 mg', 'injection', 4500),
        ('Inj. Ondansetron', '4 mg', 'injection', 1500),
        ('Inj. Paracetamol', '1 g', 'infusion', 9000),
        ('NS 500 ml', '500 ml', 'infusion', 4000),
        ('RL 500 ml', '500 ml', 'infusion', 4200),
        ('Inj. Enoxaparin', '40 mg', 'injection', 35000),
        ('Inj. Insulin regular', '10 IU', 'injection', 2000),
        ('Tab. Paracetamol', '500 mg', 'tablet', 200),
        ('Inj. Tramadol', '50 mg', 'injection', 2500),
        ('Inj. Midazolam', '5 mg', 'injection', 3000),
        ('Inj. Morphine', '10 mg', 'injection', 4000)
      ) as v(name, strength, form, price)`;

    await tx`
      insert into wards (hospital_id, branch_id, name, sort_order, daily_charge_item_id)
      select ${hospitalId}, b.id, 'Ward ' || n, n,
             (select id from charge_items where hospital_id = ${hospitalId} and kind = 'room'
              order by name offset (n % 3) limit 1)
      from generate_series(1, ${wardCount}) n
      join lateral (select id from branches where hospital_id = ${hospitalId}
                    order by name offset ((n - 1) % ${branchCount}) limit 1) b on true`;

    await tx`
      insert into beds (hospital_id, ward_id, label, sort_order)
      select ${hospitalId}, w.id, n::text, n
      from generate_series(1, ${beds}) n
      join lateral (select id from wards where hospital_id = ${hospitalId}
                    order by sort_order offset ((n - 1) % ${wardCount}) limit 1) w on true`;

    /**
     * Stays, back to back per bed, counted backwards from now. Stay 1 on a bed
     * is the current one (open) for ~85% of beds; the rest are discharged.
     * `pg_temp.h` is a non-negative hash (see main), so `% n` is always in range.
     */
    await tx`
      create temporary table synth_stays on commit drop as
      with slots as (
        select bd.id as bed_id, w.branch_id, s.n,
               1 + pg_temp.h(bd.id::text || ':' || s.n) % 8 as los_days,
               pg_temp.h(bd.id::text || ':occ') % 100 < 85 as occupied
        from beds bd
        join wards w on w.id = bd.ward_id
        cross join generate_series(1, ${days}) s(n)
        where bd.hospital_id = ${hospitalId}
      ),
      timed as (
        select *, sum(los_days) over (partition by bed_id order by n) as end_offset from slots
      )
      select bed_id, branch_id, n,
             now() - make_interval(days => end_offset::int) + make_interval(hours => 10 + n % 8) as start_at,
             case when n = 1 and occupied then null
                  else now() - make_interval(days => (end_offset - los_days)::int)
                       + make_interval(hours => 9 + n % 6) - interval '1 day'
             end as end_at,
             gen_random_uuid() as patient_id,
             gen_random_uuid() as encounter_id,
             gen_random_uuid() as admission_id,
             gen_random_uuid() as assignment_id
      from timed
      where end_offset - los_days < ${days}`;

    // A discharged stay must end after it starts; the shortest stays end the next day.
    await tx`update synth_stays set end_at = start_at + interval '20 hours' where end_at is not null and end_at <= start_at`;

    await tx`
      insert into patients (id, hospital_id, phone_e164, name, age, gender, address)
      select patient_id, ${hospitalId},
             '+9198' || lpad((pg_temp.h(patient_id::text) % 100000000)::text, 8, '0'),
             'Patient ' || substr(patient_id::text, 1, 8),
             1 + pg_temp.h(patient_id::text || 'age') % 90,
             case when pg_temp.h(patient_id::text || 'g') % 2 = 0 then 'Male' else 'Female' end,
             'Village ' || pg_temp.h(patient_id::text || 'v') % 400
      from synth_stays`;

    await tx`
      insert into encounters (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage, status, opened_at, closed_at)
      select s.encounter_id, ${hospitalId}, s.branch_id, s.patient_id,
             d.ids[1 + pg_temp.h(s.admission_id::text) % array_length(d.ids, 1)],
             'emergency', 'ipd',
             case when s.end_at is null then 'open' else 'closed' end::encounter_status,
             s.start_at, s.end_at
      from synth_stays s
      join (select branch_id, array_agg(id order by name) as ids
            from doctors where hospital_id = ${hospitalId} group by branch_id) d on d.branch_id = s.branch_id`;

    await tx`
      insert into admissions (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id,
                              status, requested_at, admitted_at, discharged_at)
      select s.admission_id, ${hospitalId}, s.encounter_id, s.patient_id, s.branch_id, e.attending_doctor_id,
             case when s.end_at is null then 'admitted' else 'discharged' end::admission_status,
             s.start_at - interval '20 minutes', s.start_at, s.end_at
      from synth_stays s join encounters e on e.id = s.encounter_id`;

    await tx`
      insert into bed_assignments (id, hospital_id, admission_id, bed_id, from_at, to_at)
      select assignment_id, ${hospitalId}, admission_id, bed_id, start_at, end_at from synth_stays`;

    // 4–12 bedside entries per stay-day; one in three is a consumable or procedure.
    await tx`
      insert into care_entries (hospital_id, admission_id, encounter_id, patient_id, medicine_id, charge_item_id,
                                description, quantity, occurred_at, recorded_at, client_id)
      with meds as (
        select array_agg(id order by name) as ids, array_agg(name || ' ' || coalesce(strength, '') order by name) as names
        from medicines where hospital_id = ${hospitalId}
      ),
      items as (
        select array_agg(id order by name) as ids, array_agg(name order by name) as names
        from charge_items where hospital_id = ${hospitalId} and kind <> 'room'
      )
      select ${hospitalId}, s.admission_id, s.encounter_id, s.patient_id,
             case when p.pick % 3 <> 0 then meds.ids[1 + p.pick % array_length(meds.ids, 1)] end,
             case when p.pick % 3 = 0 then items.ids[1 + p.pick % array_length(items.ids, 1)] end,
             case when p.pick % 3 <> 0 then meds.names[1 + p.pick % array_length(meds.ids, 1)]
                  else items.names[1 + p.pick % array_length(items.ids, 1)] end,
             1 + p.pick % 2,
             t.at, t.at + make_interval(mins => (p.pick % 40)::int),
             gen_random_uuid()
      from synth_stays s
      cross join meds
      cross join items
      cross join lateral generate_series(
        s.start_at, coalesce(s.end_at, now() - interval '1 hour'), interval '1 day') as day(d)
      cross join lateral generate_series(1, 4 + (pg_temp.h(s.admission_id::text || day.d::text) % 9)::int) as k(i)
      cross join lateral (select pg_temp.h(s.admission_id::text || day.d::text || k.i) as pick) p
      cross join lateral (select day.d + make_interval(mins => (p.pick % 1440)::int) as at) t
      where t.at <= coalesce(s.end_at, now())`;

    // Logins for the load test: an owner and a nurse, each with a live session.
    for (const role of ['owner', 'nurse'] as const) {
      const [user] = await tx<{ id: string }[]>`
        insert into users (email, password_hash, name, active, must_change_password)
        values (${`${role}+${index + 1}@synth.local`}, ${passwordHash}, ${`Synthetic ${role} ${index + 1}`}, true, false)
        returning id`;
      await tx`
        insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
        select ${user.id}, ${hospitalId}, id, ${role}::staff_role, true
        from branches where hospital_id = ${hospitalId} order by name limit 1`;
      const token = randomBytes(32).toString('base64url');
      await tx`
        insert into sessions (user_id, hospital_id, token_hash, expires_at)
        values (${user.id}, ${hospitalId}, ${createHash('sha256').update(token).digest('hex')},
                now() + make_interval(days => ${SESSION_DAYS}))`;
      fixture.sessions[role] = token;
    }

    // What the k6 scripts post against: current stays and the medicine list.
    fixture.admissions = (
      await tx<{ id: string }[]>`
        select id from admissions where hospital_id = ${hospitalId} and status = 'admitted' order by id limit 40`
    ).map((row) => row.id);
    fixture.medicines = (
      await tx<{ id: string }[]>`select id from medicines where hospital_id = ${hospitalId} order by name`
    ).map((row) => row.id);
  });

  const [{ stays, entries }] = await asTenant(sql, hospitalId, (tx) => tx<{ stays: number; entries: number }[]>`
    select (select count(*)::int from admissions where hospital_id = ${hospitalId}) as stays,
           (select count(*)::int from care_entries where hospital_id = ${hospitalId}) as entries`);
  return { beds, stays, entries, fixture };
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to generate synthetic data in production');
  const profileName = option('profile') ?? 'tiny';
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile ${profileName}; use ${Object.keys(PROFILES).join(', ')}`);

  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');
  const database = new URL(url).pathname.slice(1);
  if (!ALLOWED_DATABASE.test(database)) {
    throw new Error(`refusing to write synthetic data to "${database}"; use a database named qurio_load* or qurio_scratch`);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // A non-negative hash for picking rows deterministically; `abs(hashtext())` overflows on -2^31.
    await sql`create or replace function pg_temp.h(t text) returns bigint language sql immutable
              as $$ select hashtext(t)::bigint & 2147483647 $$`;
    console.log(`profile ${profileName}: ${profile.hospitals} hospitals, ${profile.days} days, into ${database}`);
    const removed = await sql`delete from hospitals where slug like ${`${SLUG_PREFIX}%`} returning id`;
    await sql`delete from users where email like '%@synth.local'`;
    if (removed.length) console.log(`removed ${removed.length} synthetic hospitals from an earlier run`);

    const passwordHash = await hashPassword(process.env.SYNTH_PASSWORD ?? randomBytes(18).toString('base64url'));
    const fixtures: LoadFixture[] = [];
    const started = Date.now();
    let totals = { beds: 0, stays: 0, entries: 0 };

    for (let i = 0; i < profile.hospitals; i++) {
      const result = await buildHospital(sql, i, profile.days, passwordHash);
      totals = { beds: totals.beds + result.beds, stays: totals.stays + result.stays, entries: totals.entries + result.entries };
      fixtures.push(result.fixture);
      if ((i + 1) % 10 === 0 || i + 1 === profile.hospitals) {
        console.log(`  ${i + 1}/${profile.hospitals} hospitals · ${totals.beds} beds · ${totals.stays} stays · ${totals.entries} entries · ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }

    await sql`analyze`;
    mkdirSync('loadtest', { recursive: true });
    writeFileSync(
      'loadtest/.sessions.json',
      JSON.stringify({ database, created: new Date().toISOString(), hospitals: fixtures }, null, 2),
    );
    console.log(`wrote ${fixtures.length} hospitals' sessions to loadtest/.sessions.json`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
