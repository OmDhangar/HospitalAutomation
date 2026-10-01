import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { searchMedicines } from '@/lib/services/medicines';

/**
 * Medicine typeahead.
 *
 * A GET route rather than a server action on purpose: Next.js runs a page's
 * server actions one at a time, so a search fired while an autosave is in
 * flight would queue behind it — and a typeahead that lags one keystroke
 * behind feels broken. A plain GET runs alongside.
 *
 *   /api/medicines/search?q=para            names only, for prescribing
 *   /api/medicines/search?q=para&priced=1   with selling price, for billing
 *
 * The prescribing search returns no price at all: pricing is not part of a
 * clinical decision, so it is left out of the response, not hidden in the UI.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').slice(0, 60);
  const priced = params.get('priced') === '1';

  if (priced && !can(session.role, 'billing.collect') && !can(session.role, 'medicines.manage')) {
    return NextResponse.json({ error: 'Not allowed to see prices' }, { status: 403 });
  }

  const results = priced
    ? await searchMedicines({ hospitalId: session.hospitalId, query, withPrice: true })
    : await searchMedicines({ hospitalId: session.hospitalId, query });

  return NextResponse.json({ results });
}
