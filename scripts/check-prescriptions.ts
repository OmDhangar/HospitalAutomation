import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const [{ count }] = await sql`select count(*) from prescriptions`;
  console.log('Total prescriptions count:', count);

  const tokens = await sql`
    select public_token, status, doctor_id, patient_id
    from appointments
    where hospital_id is not null
    order by id desc
    limit 10
  `;
  console.log('Appointments tokens:', tokens);

  await sql.end();
}

main().catch(console.error);