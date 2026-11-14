import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const staff = await sql`
    select u.id, u.email, u.name, sm.role, sm.hospital_id, d.id as doctor_id, d.name as doctor_name
    from staff_memberships sm
    join users u on u.id = sm.user_id
    left join doctors d on d.user_id = u.id
  `;
  console.log('Staff members:');
  console.log(staff);

  const doctorsWithoutUser = await sql`
    select id, name, specialty, user_id from doctors where user_id is null
  `;
  console.log('Doctors without user:');
  console.log(doctorsWithoutUser);

  await sql.end();
}

main().catch(console.error);
