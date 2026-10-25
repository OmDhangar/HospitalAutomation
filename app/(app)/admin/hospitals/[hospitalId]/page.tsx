import { notFound } from 'next/navigation';
import { Alert } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  TRIAL_MAX_DAYS,
  TRIAL_MIN_DAYS,
} from '@/lib/domain/subscription';
import { getAccountDetail } from '@/lib/services/platform-accounts';
import { listAssignableTiers } from '@/lib/services/custom-plans';
import { activeRevokeReason, getPlanAccess } from '@/lib/services/subscriptions';
import { getBindingView } from '@/lib/services/whatsapp-byo';
import { listAuditLogs, type AuditRow } from '@/lib/services/audit';
import { groupConsecutiveEvents } from '@/lib/domain/audit';
import {
  addStaffAction,
  changePlanAction,
  extendTermAction,
  renewTermAction,
  restorePlanAction,
  revokePlanAction,
  setHospitalActiveAction,
  setMembershipActiveAction,
  setSubscriptionStatusAction,
  setUserActiveAction,
  startImpersonationAction,
  startTrialAction,
  updateProfileAction,
} from './actions';
import { AccountHeader } from './components/account-header';
import { AccountKpiStrip } from './components/account-kpi-strip';
import { PlanSummaryCard } from './components/plan-summary-card';
import { PlanActionsCard } from './components/plan-actions-card';
import { EntitlementsCard } from './components/entitlements-card';
import { UsageThisPeriodCard } from './components/usage-card';
import { WhatsAppStatusCard } from './components/whatsapp-status-card';
import { LoginsTable } from './components/logins-table';
import { ProfileCard } from './components/profile-card';
import { DangerZoneCard } from './components/danger-zone-card';
import { ActivityPanel } from './components/activity-panel';

export const metadata = { title: 'Account · Platform' };

export default async function AccountDetailPage({
  params,
  searchParams,
}: PageProps<'/admin/hospitals/[hospitalId]'>) {
  await requirePlatformAdmin();
  const { hospitalId } = await params;
  const query = await searchParams;

  const [detail, tiers, binding, access, revokeReason, auditLogs] = await Promise.all([
    getAccountDetail(hospitalId),
    listAssignableTiers().catch(() => []),
    getBindingView(hospitalId).catch(() => null),
    getPlanAccess(hospitalId),
    activeRevokeReason(hospitalId),
    listAuditLogs({ hospitalId, limit: 200 }).catch(() => [] as AuditRow[]),
  ]);

  if (!detail) notFound();
  const { account } = detail;

  const currentTerm = detail.subscriptionHistory.find((row) => row.supersededAt === null);

  // Group and filter audit logs
  const events = auditLogs.length > 0 ? auditLogs : (detail.audit ?? []);
  const allGroups = groupConsecutiveEvents(events);

  const activeTab = typeof query.tab === 'string' ? query.tab : 'activity';
  const activeCategory = typeof query.category === 'string' ? query.category : 'all';
  const activeActor = typeof query.actor === 'string' ? query.actor : 'all';
  const searchQuery = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';

  const filteredAuditGroups = allGroups.filter((group) => {
    if (activeCategory !== 'all') {
      if (activeCategory === 'destructive') {
        if (!group.isDestructive) return false;
      } else if (group.category !== activeCategory) {
        return false;
      }
    }
    if (activeActor !== 'all') {
      if (group.actorName !== activeActor) return false;
    }
    if (searchQuery) {
      const matchesAction = group.action.toLowerCase().includes(searchQuery);
      const matchesActor = group.actorName?.toLowerCase().includes(searchQuery);
      if (!matchesAction && !matchesActor) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <AccountHeader
        account={account}
        branches={detail.branches}
        canImpersonate={true}
      />

      <Notices query={query} />

      <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-12">
          <AccountKpiStrip
            account={account}
            currentTerm={currentTerm}
            dailyCapacity={detail.dailyCapacity}
            whatsapp={detail.whatsapp}
            binding={binding}
          />
        </div>

        <div className="lg:col-span-7 space-y-5">
          <PlanSummaryCard account={account} currentTerm={currentTerm} access={access} />
          <PlanActionsCard
            hospitalId={account.hospitalId}
            currentTerm={currentTerm}
            endsAtIso={account.term.endsAt?.toISOString().slice(0, 10)}
            tiers={tiers}
          />
        </div>
        <div className="lg:col-span-5">
          <EntitlementsCard
            entitlements={account.entitlements}
            features={detail.features}
          />
        </div>

        <div className="lg:col-span-7">
          <UsageThisPeriodCard
            period={detail.period}
            appointments={detail.appointments}
            messages={detail.messages}
          />
        </div>
        <div className="lg:col-span-5">
          <WhatsAppStatusCard
            hospitalId={account.hospitalId}
            binding={binding}
            number={detail.whatsapp}
          />
        </div>

        <div className="lg:col-span-7">
          <LoginsTable hospitalId={account.hospitalId} users={detail.users} />
        </div>
        <div className="lg:col-span-5">
          <ProfileCard account={account} branches={detail.branches} />
        </div>

        <div className="lg:col-span-12">
          <ActivityPanel
            activeTab={activeTab}
            activeCategory={activeCategory}
            activeActor={activeActor}
            searchQuery={typeof query.q === 'string' ? query.q : ''}
            auditGroups={filteredAuditGroups}
            users={detail.users}
            payments={detail.payments}
            history={detail.subscriptionHistory}
            timezone={account.timezone}
          />
        </div>
        <div className="lg:col-span-12">
          <DangerZoneCard
            hospitalId={account.hospitalId}
            hasCurrentPlan={Boolean(currentTerm)}
            revokeReason={revokeReason}
            accountActive={account.active}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Outcomes, matched against a known list rather than printed.
 *
 * Same reasoning as the existing platform notices: a query string is editable
 * by whoever is looking at it, so nothing from it reaches the page as text.
 */
const DONE_MESSAGES: Record<string, string> = {
  suspended: 'Account suspended. Its staff can still sign in — set the subscription to suspended too if that was the intent.',
  activated: 'Account reactivated.',
  profile: 'Profile saved.',
  plan: 'Plan changed. A new term has been opened.',
  status: 'Subscription status set.',
  extended: 'Expiry extended on the same tier and price.',
  renewed: 'Renewed for one more term.',
  user_activated: 'Login enabled.',
  user_deactivated: 'Login disabled and every session ended.',
  access_restored: 'Access to this hospital restored.',
  access_revoked: 'Access to this hospital revoked and sessions ended.',
  staff_added:
    'Login created. Nobody can use it yet: issue a temporary password from the staff list below.',
  waba_bound: 'WhatsApp credentials sealed and stored. Point Meta at the callback URL shown below.',
  custom_plan: 'Bespoke plan created and applied. It is hidden from public pricing.',
  trial: 'Free trial started. It ends by itself; the owner then renews at the tier’s price.',
  revoked: 'Plan revoked. Staff are locked out at their next page load and online booking is off.',
  restored: 'Plan restored. Staff can use QuriioHQ again.',
};

const ERROR_MESSAGES: Record<string, string> = {
  CONFIRM: 'Type SUSPEND exactly to confirm. Nothing was changed.',
  CONFIRM_REVOKE: 'Type REVOKE exactly to confirm. Nothing was changed.',
  INVALID_TRIAL_DAYS: `A trial is ${TRIAL_MIN_DAYS} to ${TRIAL_MAX_DAYS} whole days. Nothing was changed.`,
  NOTHING_TO_REVOKE: 'This hospital has no current plan to revoke.',
  NOTHING_TO_RESTORE: 'There is no revoke to undo.',
  REASON_REQUIRED: 'A reason is required — it goes in the hospital’s audit log.',
  INVALID_INPUT: 'Something was missing or malformed. Nothing was changed.',
  UNKNOWN_TIER: 'That plan tier does not exist.',
  NO_SUBSCRIPTION: 'There is no subscription to renew. Assign a plan first.',
  LAST_OWNER: 'That is the only active owner. Add another before removing this one.',
  MEMBERSHIP_NOT_FOUND: 'That user is not a member of this hospital.',
  USER_NOT_FOUND: 'That user no longer exists.',
  HOSPITAL_NOT_FOUND: 'That hospital no longer exists.',
  PLAN_LIMIT: 'The plan’s staff-login limit is reached. Upgrade the tier first.',
  EMAIL_IN_USE:
    'That email already has a login. Each login belongs to one hospital — use a different email.',
  NOT_PLATFORM_ADMIN: 'Not permitted.',
  INVALID_PHONE_NUMBER_ID: 'That phone number ID does not look like one of Meta’s.',
  NUMBER_TAKEN: 'That phone number ID is already bound to another hospital.',
  MISSING_FIELD: 'Every WhatsApp field except the three optional ones is required.',
  NO_ENCRYPTION_KEY:
    'WHATSAPP_ENCRYPTION_KEY is not set on this server, so credentials cannot be sealed.',
};

function Notices({ query }: { query: Record<string, string | string[] | undefined> }) {
  const done = typeof query.done === 'string' ? DONE_MESSAGES[query.done] : undefined;
  const error = typeof query.error === 'string' ? ERROR_MESSAGES[query.error] : undefined;

  if (!done && !error) return null;

  return (
    <div className="space-y-2">
      {done ? <Alert tone="success">{done}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

