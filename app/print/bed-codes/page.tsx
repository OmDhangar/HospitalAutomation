import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/booking-trace/print-button';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { listBedCodes } from '@/lib/services/mar';
import { bedQrPayload } from '@/lib/domain/mar';
import { qrMatrix, qrSvgPath } from '@/lib/qr/encode';

export const metadata = { title: 'Bed codes' };

/**
 * Bed code labels (IPD sheets plan §5, §7.2): one per bed, to stick on the
 * bed head. A nurse giving a risk-class dose from her own phone types the
 * code to show she is at the bedside. Codes are given the first time they are
 * printed and never change; a reprint shows the same codes.
 */
export default async function BedCodesPrint({ searchParams }: PageProps<'/print/bed-codes'>) {
  const session = await requireSession();
  await requireModule(session, 'mar');
  if (!can(session.role, 'ipd.bedCodes')) notFound();
  const query = await searchParams;
  const wardId = typeof query.ward === 'string' && /^[0-9a-f-]{36}$/i.test(query.ward) ? query.ward : null;
  const beds = await listBedCodes(session.hospitalId, wardId);

  return (
    <main className="mx-auto max-w-[210mm] bg-white p-6 print:p-0">
      <style>{'@page { size: A4; margin: 10mm; } .label { break-inside: avoid; }'}</style>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-lg font-bold">Bed codes · {session.hospitalName}</h1>
        <PrintButton />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {beds.map((b) => (
          <div key={b.id} className="label rounded-lg border-2 border-dashed border-ink-400 p-3 text-center">
            <p className="text-xs text-ink-600">
              {session.hospitalName} · {b.wardName}
            </p>
            <p className="text-lg font-bold">Bed {b.label}</p>
            {b.code ? <BedQr code={b.code} /> : null}
            <p className="mt-1 font-mono text-3xl font-bold tracking-[0.3em]">{b.code}</p>
            <p className="mt-1 text-[10px] text-ink-500">Scan, or type the code · स्कॅन करा किंवा कोड टाका</p>
          </div>
        ))}
      </div>
    </main>
  );
}

/** The bed's QR, drawn by our own encoder (lib/qr/encode.ts): crisp at any print size. */
function BedQr({ code }: { code: string }) {
  const qr = qrMatrix(bedQrPayload(code), 'M');
  const n = qr.size + 8;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className="mx-auto mt-1 size-28" role="img" aria-label={`QR code for ${code}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrSvgPath(qr)} fill="#000" />
    </svg>
  );
}
