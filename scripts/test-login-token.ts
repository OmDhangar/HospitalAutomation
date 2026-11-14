import dotenv from 'dotenv';
dotenv.config();
import { login, resolveSession } from '../lib/services/auth';

async function main() {
  const accounts = [
    { role: 'owner', email: 'owner@demo.hospital', pass: 'demo-opd-queue' },
    { role: 'doctor', email: 'doctor@demo.hospital', pass: 'demo-opd-queue' },
    { role: 'receptionist', email: 'reception@demo.hospital', pass: 'demo-opd-queue' },
    { role: 'nurse', email: 'nurse.priya@demo.hospital', pass: 'demo-opd-queue' },
  ];

  for (const acc of accounts) {
    const token = await login(acc.email, acc.pass);
    if (!token) {
      console.error(`Failed to login ${acc.role} (${acc.email})`);
      continue;
    }
    const session = await resolveSession(token);
    console.log(`✓ ${acc.role} (${acc.email}) token: ${token.slice(0, 10)}... role=${session?.role} user=${session?.name}`);
  }
}

main().catch(console.error);
