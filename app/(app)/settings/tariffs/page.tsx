import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { formatRupees } from '@/lib/domain/billing';
import { Card, EmptyState } from '@/components/ui';
import {
  listRatePlans,
  getRatePlanById,
  listChargeItemsForTariff,
} from '@/lib/services/tariffs';
import { saveRatePlanAction, setChargeItemTariffAction } from './actions';

export const metadata = { title: 'Tariff Rate Plans · Settings' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';
const INPUT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

interface PageProps {
  searchParams: Promise<{
    planId?: string;
    saved?: string;
    error?: string;
    kind?: string;
  }>;
}

export default async function TariffRatePlansPage({ searchParams }: PageProps) {
  const session = await requireSession();
  const params = await searchParams;

  if (!can(session.role, 'tariffs.manage')) {
    return (
      <Card className="p-8">
        <EmptyState title="Owners & Admins only" hint="Only hospital administrators configure tariff rate plans." />
      </Card>
    );
  }

  const plans = await listRatePlans(session.hospitalId);
  const activePlanId = params.planId || plans[0]?.id || '';
  const selectedPlanData = activePlanId
    ? await getRatePlanById(session.hospitalId, activePlanId)
    : null;
  const chargeItems = await listChargeItemsForTariff(session.hospitalId);

  // Group existing overrides by chargeItemId
  const overrideMap = new Map<string, number>();
  if (selectedPlanData?.tariffs) {
    for (const t of selectedPlanData.tariffs) {
      overrideMap.set(t.chargeItemId, t.tariffPricePaise);
    }
  }

  const activeKind = params.kind || 'all';
  const filteredItems = chargeItems.filter((item) => {
    if (activeKind === 'all') return true;
    return item.kind === activeKind;
  });

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      {/* Top Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Tariff Rate Plans</h1>
          <p className="text-sm text-ink-600">
            Configure multi-tier pricing schedules for Cash, TPA Insurance, CGHS, and Corporate tie-ups.
          </p>
        </div>
      </div>

      {/* Alert Notices */}
      {params.saved && (
        <div className="rounded-lg bg-emerald-50 p-4 border border-emerald-200 text-emerald-800 text-sm">
          {params.saved}
        </div>
      )}
      {params.error && (
        <div className="rounded-lg bg-rose-50 p-4 border border-rose-200 text-rose-800 text-sm">
          {params.error}
        </div>
      )}

      {/* Rate Plans List & Creation Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left Column: Plan Selector & Plan Cards */}
        <div className="space-y-4 lg:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">Rate Schedules</h2>
          </div>

          <div className="space-y-2">
            {plans.map((p) => {
              const isSelected = p.id === activePlanId;
              const modifierDisplay =
                p.modifierBp > 0
                  ? `+${p.modifierBp / 100}%`
                  : p.modifierBp < 0
                  ? `${p.modifierBp / 100}%`
                  : 'Base Rate';

              return (
                <Link
                  key={p.id}
                  href={`/settings/tariffs?planId=${p.id}`}
                  className={`block rounded-xl border p-4 transition-colors ${
                    isSelected
                      ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600'
                      : 'border-ink-200 bg-white hover:border-ink-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink-900">{p.name}</span>
                    {p.isDefault && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink-600">
                    <span className="uppercase font-mono">{p.code}</span>
                    <span>·</span>
                    <span className="capitalize">{p.payerKind}</span>
                    <span>·</span>
                    <span className="font-semibold text-ink-700">{modifierDisplay}</span>
                  </div>
                </Link>
              );
            })}

            {plans.length === 0 && (
              <div className="rounded-xl border border-dashed border-ink-300 p-6 text-center text-sm text-ink-500">
                No custom rate plans yet. Standard catalog prices are used by default.
              </div>
            )}
          </div>

          {/* Add Plan Card */}
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-ink-900 mb-3">+ Add New Rate Plan</h3>
            <form action={saveRatePlanAction} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-700">Plan Name</label>
                <input
                  type="text"
                  name="name"
                  placeholder="e.g. Star Health TPA"
                  required
                  className={INPUT_CLASS}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-ink-700">Plan Code</label>
                  <input
                    type="text"
                    name="code"
                    placeholder="STAR-TPA"
                    required
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-700">Payer Type</label>
                  <select name="payerKind" className={SELECT_CLASS}>
                    <option value="self">Self / Cash</option>
                    <option value="tpa">TPA</option>
                    <option value="insurer">Insurer</option>
                    <option value="corporate">Corporate</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-700">Payer / Corporate Name (Optional)</label>
                <input
                  type="text"
                  name="payerName"
                  placeholder="e.g. Star Health Insurance"
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-700">
                  General Modifier % (e.g. +10 or -15)
                </label>
                <input
                  type="number"
                  step="0.5"
                  name="modifierPercent"
                  defaultValue="0"
                  className={INPUT_CLASS}
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" id="isDefault" name="isDefault" className="rounded border-ink-300 text-brand-600" />
                <label htmlFor="isDefault" className="text-xs text-ink-700">
                  Set as default hospital rate plan
                </label>
              </div>

              <button
                type="submit"
                className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition"
              >
                Create Rate Plan
              </button>
            </form>
          </Card>
        </div>

        {/* Right Column: Tariff Overrides Matrix */}
        <div className="space-y-4 lg:col-span-2">
          {selectedPlanData?.plan ? (
            <Card className="overflow-hidden">
              <div className="border-b border-ink-200 bg-ink-50/50 p-4 sm:flex sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-ink-900">{selectedPlanData.plan.name} Tariffs</h2>
                  <p className="text-xs text-ink-600">
                    Plan Code: <span className="font-mono uppercase">{selectedPlanData.plan.code}</span> · Modifier:{' '}
                    {selectedPlanData.plan.modifierBp !== 0
                      ? `${selectedPlanData.plan.modifierBp / 100}% on unpriced items`
                      : 'None'}
                  </p>
                </div>
                <div className="mt-2 flex gap-1 sm:mt-0">
                  {['all', 'room', 'procedure', 'service', 'consumable'].map((k) => (
                    <Link
                      key={k}
                      href={`/settings/tariffs?planId=${activePlanId}&kind=${k}`}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                        activeKind === k
                          ? 'bg-ink-900 text-white'
                          : 'bg-white text-ink-700 border border-ink-200 hover:bg-ink-50'
                      }`}
                    >
                      {k}
                    </Link>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-ink-200 text-left text-sm">
                  <thead className="bg-ink-50 text-xs font-semibold text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Charge Item</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Catalog Price</th>
                      <th className="px-4 py-3">Plan Tariff</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100 bg-white">
                    {filteredItems.map((item) => {
                      const overridePaise = overrideMap.get(item.id);
                      const hasOverride = overridePaise !== undefined;
                      const basePrice = item.sellingPricePaise !== null ? item.sellingPricePaise : 0;
                      const calculatedTariff = hasOverride
                        ? overridePaise!
                        : selectedPlanData.plan.modifierBp !== 0
                        ? Math.max(0, Math.round((basePrice * (10000 + selectedPlanData.plan.modifierBp)) / 10000))
                        : basePrice;

                      return (
                        <tr key={item.id} className="hover:bg-ink-50/60">
                          <td className="px-4 py-3 font-medium text-ink-900">{item.name}</td>
                          <td className="px-4 py-3 text-xs capitalize text-ink-600">{item.kind}</td>
                          <td className="px-4 py-3 text-ink-700">
                            {item.sellingPricePaise !== null ? formatRupees(item.sellingPricePaise) : 'Unpriced'}
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-semibold text-ink-900">{formatRupees(calculatedTariff)}</span>
                            {hasOverride && (
                              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                Override
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <form action={setChargeItemTariffAction} className="inline-flex items-center gap-1.5">
                              <input type="hidden" name="ratePlanId" value={activePlanId} />
                              <input type="hidden" name="chargeItemId" value={item.id} />
                              <input
                                type="number"
                                step="0.01"
                                name="tariffPrice"
                                placeholder={(calculatedTariff / 100).toFixed(2)}
                                defaultValue={hasOverride ? (overridePaise! / 100).toFixed(2) : ''}
                                className="w-24 rounded border border-ink-300 px-2 py-1 text-xs text-right focus:border-brand-600 focus:outline-none"
                              />
                              <button
                                type="submit"
                                className="rounded bg-ink-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-ink-900 transition"
                              >
                                Save
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}

                    {filteredItems.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-500">
                          No charge items found for this category.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-center text-sm text-ink-500">
              Select or create a rate plan on the left to configure tariff overrides.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
