import { stopImpersonationAction } from '@/app/(app)/admin/actions';

/**
 * The strip that says you are not looking at your own account.
 *
 * Deliberately loud, deliberately sticky, and deliberately above everything
 * else in the layout. The failure mode this exists to prevent is an operator
 * forgetting which hospital's queue is on screen and telling a customer
 * something about somebody else's patients.
 */
export function ImpersonationBanner({
  hospitalName,
  readOnly,
}: {
  hospitalName: string;
  readOnly: boolean;
}) {
  return (
    <div className="sticky top-14 z-30 border-b border-violet-300 bg-violet-100">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-3.5 py-2 sm:px-6">
        <p className="text-sm text-violet-900">
          <span className="font-semibold">Support session</span> — viewing{' '}
          <span className="font-semibold">{hospitalName}</span>
          {readOnly ? (
            <span className="ml-1.5 rounded bg-violet-200 px-1.5 py-0.5 text-xs font-medium">
              read-only
            </span>
          ) : null}
          <span className="ml-2 hidden text-xs text-violet-700 sm:inline">
            Logged in this hospital&rsquo;s own audit trail. Expires within 30 minutes.
          </span>
        </p>
        <form action={stopImpersonationAction}>
          <button
            type="submit"
            className="rounded-lg bg-violet-800 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-900"
          >
            Stop and return
          </button>
        </form>
      </div>
    </div>
  );
}
