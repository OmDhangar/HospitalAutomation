import postgres from 'postgres';
import dotenv from 'dotenv';
import { hashPassword } from '../lib/security/password';
dotenv.config();

const sql = postgres(process.env.DATABASE_ADMIN_URL!);

async function main() {
  const hash = await hashPassword('demo-opd-queue');
  await sql`update users set password_hash = ${hash} where email = 'nurse.priya@demo.hospital'`;
  console.log('Updated nurse password to demo-opd-queue');
  await sql.end();
}

main().catch(console.error);
