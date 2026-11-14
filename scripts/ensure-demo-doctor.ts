import postgres from 'postgres';
import dotenv from 'dotenv';
import { hashPassword } from '../lib/security/password';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const [hospital] = await sql`select id from hospitals where slug = 'demo-hospital' limit 1`;
  if (!hospital) throw new Error('demo-hospital not found');

  const [branch] = await sql`select id from branches where hospital_id = ${hospital.id} limit 1`;
  const [doctor] = await sql`select id, name from doctors where hospital_id = ${hospital.id} and name = 'Dr. Rajesh Kulkarni' limit 1`;
  if (!doctor) throw new Error('Dr. Rajesh Kulkarni not found');

  const passwordHash = await hashPassword('demo-opd-queue');

  let [user] = await sql`select id from users where email = 'doctor@demo.hospital'`;
  if (!user) {
    [user] = await sql`
      insert into users (email, password_hash, name, is_platform_admin, active)
      values ('doctor@demo.hospital', ${passwordHash}, 'Dr. Rajesh Kulkarni', false, true)
      returning id
    `;
  }

  await sql`
    insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
    values (${user.id}, ${hospital.id}, ${branch.id}, 'doctor', true)
    on conflict do nothing
  `;

  await sql`
    update doctors set user_id = ${user.id} where id = ${doctor.id}
  `;

  console.log(`✓ Doctor user linked: doctor@demo.hospital / demo-opd-queue -> ${doctor.name}`);
  await sql.end();
}

main().catch(console.error);
