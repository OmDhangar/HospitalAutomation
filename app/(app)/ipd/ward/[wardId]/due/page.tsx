import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { MarError } from '@/lib/domain/mar';
import { can } from '@/lib/domain/permissions';
import { getWardBoard } from '@/lib/services/due';
import { DueBoard } from './due-board';

export const metadata = { title: 'Due board · IPD' };

/**
 * The ward's due board (IPD sheets plan B3b, §7.10). Rendered with today's
 * data; the board then keeps itself current (and works from its last copy
 * when the connection drops).
 */
export default async function DueBoardPage({ params }: PageProps<'/ipd/ward/[wardId]/due'>) {
  const session = await requireSession();
  await requireModule(session, 'mar');
  if (!can(session.role, 'ipd.dueBoard')) notFound();
  const { wardId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(wardId)) notFound();
  let board;
  try {
    board = await getWardBoard({ hospitalId: session.hospitalId, wardId, userId: session.userId, timezone: session.timezone });
  } catch (err) {
    if (err instanceof MarError) notFound();
    throw err;
  }
  return (
    <div className="mx-auto max-w-6xl">
      <DueBoard initial={board} isTablet={session.channel === 'ward_device'} canSnooze={!session.readOnly && can(session.role, 'ipd.dueBoard')} />
    </div>
  );
}
