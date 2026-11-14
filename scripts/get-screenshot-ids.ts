import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const [hospital] = await sql`select id from hospitals where slug = 'demo-hospital'`;
  const [branch] = await sql`select id from branches where hospital_id = ${hospital.id}`;
  const [admission] = await sql`select id, ipd_number from admissions where hospital_id = ${hospital.id} limit 1`;
  const [ward] = await sql`select id, name from wards where hospital_id = ${hospital.id} and name like 'Female%' limit 1`;
  const [bed] = await sql`select id, label from beds where ward_id = ${ward?.id} and label = '12' limit 1`;
  const [cleaningBed] = await sql`select id, label from beds where ward_id = ${ward?.id} and status = 'cleaning' limit 1`;
  const [appointment] = await sql`select id, public_token, patient_id from appointments where hospital_id = ${hospital.id} limit 1`;
  const [encounter] = await sql`select id, appointment_id from encounters where hospital_id = ${hospital.id} limit 1`;
  const [bill] = await sql`select id from bills where hospital_id = ${hospital.id} limit 1`;
  const [doctor] = await sql`select id, name from doctors where hospital_id = ${hospital.id} limit 1`;

  const data = {
    hospitalId: hospital.id,
    branchId: branch.id,
    admissionId: admission?.id,
    ipdNumber: admission?.ipd_number,
    wardId: ward?.id,
    bedId: bed?.id,
    cleaningBedId: cleaningBed?.id,
    appointmentToken: appointment?.public_token,
    encounterId: encounter?.id,
    billId: bill?.id,
    doctorId: doctor?.id,
  };

  console.log('SCREENSHOT_IDS =', JSON.stringify(data, null, 2));
  await sql.end();
}

main().catch(console.error);
