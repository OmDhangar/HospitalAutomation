'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import {
  isChargeItemKind,
  parseChargeItemCsv,
  describeSavedPrices,
  parsePriceEdits,
  priceLabelsFrom,
} from '@/lib/domain/ipd-config';
import { parsePercentToBasisPoints, parseRupeesToPaise } from '@/lib/domain/patient-billing';
import { can, type Permission } from '@/lib/domain/permissions';
import {
  IpdConfigError,
  addBeds,
  addStarterChargeItems,
  createChargeItem,
  createWard,
  importChargeItems,
  setBedActive,
  setChargeItemActive,
  setChargeItemPrices,
  setWardActive,
  updateChargeItem,
  updateWard,
} from '@/lib/services/ipd-config';
import { UndoError, undoAddBeds, undoCreateItem, undoCreateWard, undoPriceBatch } from '@/lib/services/ipd-undo';
import { formatUndoToken, idList, isId, parseUndoToken } from '@/lib/domain/undo';

/**
 * Settings → IPD. Plain form posts that redirect back with a message, the
 * same shape as the rest of Settings, so the screens work with no client
 * JavaScript (the CSV preview is the one exception, and it re-parses here).
 *
 * Wards and beds are `ipd.configure`; anything with a price is `billing.price`.
 */

const WARDS_PAGE = '/settings/ipd';
const ITEMS_PAGE = '/settings/ipd/items';

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) {
    throw new Error('Only the hospital owner can change IPD settings');
  }
  return session;
}

const back = (page: string, params: Record<string, string>, keep?: FormData): never => {
  const query = new URLSearchParams(params);
  for (const key of ['q', 'filter', 'kind', 'mode']) {
    const value = String(keep?.get(`_${key}`) ?? '');
    if (value) query.set(key, value);
  }
  revalidatePath(page);
  const text = query.toString();
  redirect(`${page}${text ? `?${text}` : ''}`);
};

const text = (form: FormData, key: string) => String(form.get(key) ?? '');
const optionalId = (form: FormData, key: string) => text(form, key).trim() || null;

/** Runs a service call; an IpdConfigError becomes the page's error message. */
async function attempt<T>(page: string, form: FormData, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IpdConfigError) back(page, { error: err.message }, form);
    throw err;
  }
}

/* ---------------------------------------------------------- wards, beds */

export async function createWardAction(form: FormData) {
  const session = await authorize('ipd.configure');
  const result = await attempt(WARDS_PAGE, form, () =>
    createWard({
      hospitalId: session.hospitalId,
      branchId: text(form, 'branchId'),
      name: text(form, 'name'),
      dailyChargeItemId: optionalId(form, 'dailyChargeItemId'),
      bedLabels: text(form, 'beds'),
      actorUserId: session.userId,
    }),
  );
  back(WARDS_PAGE, {
    saved: result.bedsAdded > 0 ? `Ward added with ${result.bedsAdded} beds` : 'Ward added. Now add its beds.',
    undo: formatUndoToken('ward', result.wardId),
  });
}

export async function updateWardAction(form: FormData) {
  const session = await authorize('ipd.configure');
  await attempt(WARDS_PAGE, form, () =>
    updateWard({
      hospitalId: session.hospitalId,
      wardId: text(form, 'wardId'),
      name: text(form, 'name'),
      dailyChargeItemId: optionalId(form, 'dailyChargeItemId'),
      actorUserId: session.userId,
    }),
  );
  // `id` lets the page mark this ward's form saved, beside its button.
  back(WARDS_PAGE, { saved: 'Ward saved', id: text(form, 'wardId') });
}

export async function toggleWardAction(form: FormData) {
  const session = await authorize('ipd.configure');
  const active = text(form, 'active') === 'true';
  await attempt(WARDS_PAGE, form, () =>
    setWardActive({
      hospitalId: session.hospitalId,
      wardId: text(form, 'wardId'),
      active,
      actorUserId: session.userId,
    }),
  );
  back(WARDS_PAGE, {
    saved: active ? 'Ward reopened' : 'Ward closed. Its history is kept.',
    undo: formatUndoToken('toggle-ward', text(form, 'wardId'), String(active)),
  });
}

export async function addBedsAction(form: FormData) {
  const session = await authorize('ipd.configure');
  const { added, skipped, bedIds } = await attempt(WARDS_PAGE, form, () =>
    addBeds({
      hospitalId: session.hospitalId,
      wardId: text(form, 'wardId'),
      labels: text(form, 'labels'),
      actorUserId: session.userId,
    }),
  );
  back(WARDS_PAGE, {
    saved:
      skipped > 0
        ? `Added ${added} beds. ${skipped} already existed.`
        : `Added ${added} bed${added === 1 ? '' : 's'}`,
    ...(bedIds.length > 0 ? { undo: formatUndoToken('beds', bedIds.join(',')) } : {}),
    id: `beds:${text(form, 'wardId')}`,
  });
}

export async function toggleBedAction(form: FormData) {
  const session = await authorize('ipd.configure');
  const active = text(form, 'active') === 'true';
  await attempt(WARDS_PAGE, form, () =>
    setBedActive({
      hospitalId: session.hospitalId,
      bedId: text(form, 'bedId'),
      active,
      actorUserId: session.userId,
    }),
  );
  back(WARDS_PAGE, {
    saved: active ? 'Bed back in use' : 'Bed taken out of use. Its history is kept.',
    undo: formatUndoToken('toggle-bed', text(form, 'bedId'), String(active)),
  });
}

/* ------------------------------------------------------------ price list */

/** A blank price means "not priced yet"; anything else must parse. */
function readChargeItem(form: FormData): { input: Record<string, unknown> } | { error: string } {
  const kind = text(form, 'kind');
  if (!isChargeItemKind(kind)) return { error: 'Choose what kind of item this is' };
  const rawPrice = text(form, 'price').trim();
  const price = rawPrice === '' ? null : parseRupeesToPaise(rawPrice);
  if (rawPrice !== '' && price === null) return { error: 'Enter the price in rupees, like 15 or 2.50' };
  const rawTax = text(form, 'tax').trim();
  const tax = rawTax === '' ? 0 : parsePercentToBasisPoints(rawTax);
  if (tax === null) return { error: 'Enter tax as a percentage, like 12' };
  return {
    input: {
      kind,
      name: text(form, 'name'),
      unit: text(form, 'unit'),
      sellingPricePaise: price,
      taxRateBp: tax,
      isTest: form.get('isTest') === 'on',
    },
  };
}

export async function createChargeItemAction(form: FormData) {
  const session = await authorize('billing.price');
  const read = readChargeItem(form);
  if ('error' in read) back(ITEMS_PAGE, { error: read.error }, form);
  const created = await attempt(ITEMS_PAGE, form, () =>
    createChargeItem({
      hospitalId: session.hospitalId,
      input: (read as { input: Record<string, unknown> }).input,
      actorUserId: session.userId,
    }),
  );
  back(ITEMS_PAGE, { saved: 'Item added', undo: formatUndoToken('item', created.id) }, form);
}

export async function updateChargeItemAction(form: FormData) {
  const session = await authorize('billing.price');
  const read = readChargeItem(form);
  if ('error' in read) back(ITEMS_PAGE, { error: read.error }, form);
  const { billed, batch } = await attempt(ITEMS_PAGE, form, () =>
    updateChargeItem({
      hospitalId: session.hospitalId,
      chargeItemId: text(form, 'chargeItemId'),
      input: (read as { input: Record<string, unknown> }).input,
      actorUserId: session.userId,
    }),
  );
  back(
    ITEMS_PAGE,
    {
      saved:
        billed > 0
          ? `Saved, and ${billed} entr${billed === 1 ? 'y' : 'ies'} waiting for this price ${billed === 1 ? 'is' : 'are'} now billed.`
          : 'Saved. Bills already issued keep their old price.',
      undo: formatUndoToken('prices', batch),
      id: text(form, 'chargeItemId'),
      // A row has a price form and a details form; mark the one used.
      form: text(form, '_form') || 'price',
    },
    form,
  );
}

export async function toggleChargeItemAction(form: FormData) {
  const session = await authorize('billing.price');
  const active = text(form, 'active') === 'true';
  await attempt(ITEMS_PAGE, form, () =>
    setChargeItemActive({
      hospitalId: session.hospitalId,
      chargeItemId: text(form, 'chargeItemId'),
      active,
      actorUserId: session.userId,
    }),
  );
  back(
    ITEMS_PAGE,
    {
      saved: active ? 'Item restored' : 'Item removed. Old bills still show it.',
      undo: formatUndoToken('toggle-item', text(form, 'chargeItemId'), String(active)),
    },
    form,
  );
}

export async function addStarterChargeItemsAction(form: FormData) {
  const session = await authorize('billing.price');
  const { added, batch } = await addStarterChargeItems({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
  });
  back(
    ITEMS_PAGE,
    {
      saved:
        added > 0
          ? `Added ${added} common items without prices. Set prices for the ones you charge.`
          : 'All the common items are already in your list.',
      ...(added > 0 ? { undo: formatUndoToken('prices', batch) } : {}),
    },
    form,
  );
}

/**
 * Saves the CSV the owner previewed. The text is parsed again here: the
 * preview ran in the browser, and nothing from the browser is trusted. Bad
 * rows are skipped and counted, as the preview said they would be.
 */
export async function importChargeItemsAction(form: FormData) {
  const session = await authorize('billing.price');
  const preview = parseChargeItemCsv(text(form, 'csv'));
  if (preview.rows.length === 0) {
    back(ITEMS_PAGE, { error: 'Nothing to import. Paste rows like: Syringe 5 ml, consumable, syringe, 15' });
  }
  const result = await attempt(ITEMS_PAGE, form, () =>
    importChargeItems({ hospitalId: session.hospitalId, rows: preview.rows, actorUserId: session.userId }),
  );
  const parts = [`${result.added} added`, `${result.repriced} re-priced`];
  if (result.unchanged > 0) parts.push(`${result.unchanged} unchanged`);
  if (preview.errors.length > 0) parts.push(`${preview.errors.length} skipped`);
  if (result.billed > 0) parts.push(`${result.billed} waiting entries billed`);
  back(ITEMS_PAGE, { saved: `Imported: ${parts.join(', ')}.`, undo: formatUndoToken('prices', result.batch) });
}

/** The "Set prices" screen's single Save. */
export async function setChargeItemPricesAction(form: FormData) {
  const session = await authorize('billing.price');
  const edits = parsePriceEdits(
    [...form.entries()].map(([key, value]) => [key, String(value)] as [string, string]),
  );
  if (!edits.ok) back(ITEMS_PAGE, { error: edits.error, mode: 'prices' }, form);
  const { changed, billed, batch } = await setChargeItemPrices({
    hospitalId: session.hospitalId,
    edits: (edits as { ok: true; value: { id: string; sellingPricePaise: number }[] }).value,
    actorUserId: session.userId,
  });
  back(
    ITEMS_PAGE,
    {
      saved:
        changed === 0
          ? 'No prices changed.'
          : `${changed} price${changed === 1 ? '' : 's'} saved${billed > 0 ? `, and ${billed} waiting entries billed` : ''}.`,
      ...(changed > 0 ? { undo: formatUndoToken('prices', batch) } : {}),
      // Shown in the sticky bar by the Save button: priced items leave this
      // list, so without it they look like they simply vanished.
      savedList: describeSavedPrices(
        (edits as { ok: true; value: { id: string; sellingPricePaise: number }[] }).value,
        priceLabelsFrom([...form.entries()].map(([key, value]) => [key, String(value)] as [string, string])),
      ),
    },
    form,
  );
}

/* ------------------------------------------------------------------ undo */

/**
 * The Undo button on Settings → IPD and its price list. Each kind needs the
 * permission its original action needed; the service re-checks the window and
 * that nothing has used the change since.
 */
export async function undoSettingsAction(form: FormData) {
  const page = text(form, '_page') === ITEMS_PAGE ? ITEMS_PAGE : WARDS_PAGE;
  const token = parseUndoToken(text(form, 'undo'));
  if (!token) back(page, { error: 'Nothing to undo.' });
  const { kind, args } = token!;
  const configure = kind === 'ward' || kind === 'beds' || kind === 'toggle-ward' || kind === 'toggle-bed';
  const session = await authorize(configure ? 'ipd.configure' : 'billing.price');
  let message = 'Undone.';
  try {
    if (kind === 'ward' && isId(args[0])) {
      await undoCreateWard({ hospitalId: session.hospitalId, wardId: args[0], actorUserId: session.userId });
      message = 'Undone: the ward and its beds were removed.';
    } else if (kind === 'beds') {
      await undoAddBeds({ hospitalId: session.hospitalId, bedIds: idList(args[0]), actorUserId: session.userId });
      message = 'Undone: those beds were removed.';
    } else if (kind === 'toggle-ward' && isId(args[0])) {
      await setWardActive({ hospitalId: session.hospitalId, wardId: args[0], active: args[1] !== 'true', actorUserId: session.userId });
    } else if (kind === 'toggle-bed' && isId(args[0])) {
      await setBedActive({ hospitalId: session.hospitalId, bedId: args[0], active: args[1] !== 'true', actorUserId: session.userId });
    } else if (kind === 'item' && isId(args[0])) {
      await undoCreateItem({ hospitalId: session.hospitalId, kind: 'charge_item', id: args[0], actorUserId: session.userId });
      message = 'Undone: the item was removed.';
    } else if (kind === 'toggle-item' && isId(args[0])) {
      await setChargeItemActive({ hospitalId: session.hospitalId, chargeItemId: args[0], active: args[1] !== 'true', actorUserId: session.userId });
    } else if (kind === 'prices' && isId(args[0])) {
      const { restored, removed } = await undoPriceBatch({ hospitalId: session.hospitalId, batch: args[0], actorUserId: session.userId });
      message = `Undone: ${restored} price${restored === 1 ? '' : 's'} restored${removed > 0 ? `, ${removed} added item${removed === 1 ? '' : 's'} removed` : ''}.`;
    } else {
      back(page, { error: 'Nothing to undo.' });
    }
  } catch (err) {
    if (err instanceof UndoError || err instanceof IpdConfigError) back(page, { error: err.message });
    throw err;
  }
  back(page, { saved: message });
}
