import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const [user] = await sql`select id from users where email = 'nurse.priya@demo.hospital'`;
  if (!user) {
    console.log('No nurse user found');
    await sql.end();
    return;
  }
  const [hospital] = await sql`select id from hospitals where slug = 'demo-hospital'`;
  const [branch] = await sql`select id from branches where hospital_id = ${hospital.id}`;

  const rows = await sql`select * from staff_memberships where user_id = ${user.id}`;
  console.log('Current rows for nurse:', rows);

  await sql`
    update staff_memberships
    set hospital_id = ${hospital.id}, branch_id = ${branch.id}, active = true
    where user_id = ${user.id}
  `;
  console.log('Updated nurse membership to current demo hospital and branch');

  await sql.end();
}

main().catch(console.error);
