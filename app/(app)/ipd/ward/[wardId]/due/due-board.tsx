'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import {
  DEFAULT_SLOTS,
  STATUS_TEXT,
  TASK_KINDS,
  boardInstances,
  inQuietHours,
  slotOf,
  type BoardItem,
  type BoardPayload,
} from '@/lib/domain/due';
import { snoozeDynamic } from '@/app/(app)/ipd/admissions/[id]/(file)/treatment/actions';
import { acknowledgeDynamic, rateAlertsDynamic } from './actions';

/**
 * The ward's due board (IPD sheets plan B3b, §7.10): like the paper MAR round
 * — rows bed → patient → each line, columns the round times, the current
 * round highlighted; ✓ given, ✓* given late or early, ✗/H/R not given, and
 * the doses due now or overdue in colour *and* words. Time-critical lines carry
 * a clock and "TC". On a phone, one round at a time.
 *
 * It keeps working offline: the last copy of the board is kept on the device
 * and the due times are recomputed here from it (the same engine as the
 * server). The header says when it last synced — amber after 5 minutes, red
 * after 15. On a ward tablet it can chime when a time-critical dose becomes
 * overdue (setting, quiet hours); never in observe.
 */

const REFRESH_MS = 60_000;
const TICK_MS = 30_000;
const hourLabel = (h: number) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
  } catch {
    // No sound available: the board still shows it.
  }
}

export function DueBoard({ initial, isTablet, canSnooze }: { initial: BoardPayload; isTablet: boolean; canSnooze: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [payload, setPayload] = useState(initial);
  const [syncedAt, setSyncedAt] = useState(() => new Date(initial.serverNow).getTime());
  const [now, setNow] = useState(() => new Date(initial.serverNow).getTime());
  const [pending, startTransition] = useTransition();
  const cacheKey = `qurio-due-${initial.ward.id}`;

  // Keep the copy on the device; refresh from the server every minute.
  useEffect(() => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ payload, syncedAt }));
    } catch {
      // Storage full or blocked: the board still works while the page is open.
    }
  }, [cacheKey, payload, syncedAt]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/ipd/due?wardId=${initial.ward.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const next = (await res.json()) as BoardPayload;
      setPayload(next);
      setSyncedAt(Date.now());
    } catch {
      // Offline: keep the last copy.
    }
  }, [initial.ward.id]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    const online = () => void refresh();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(t);
      window.clearInterval(tick);
      window.removeEventListener('online', online);
    };
  }, [refresh]);

  const items = useMemo(() => boardInstances(payload, new Date(now)), [payload, now]);
  const lineById = useMemo(() => new Map(payload.lines.map((l) => [l.orderId, l])), [payload.lines]);
  const bedOf = useMemo(() => new Map(payload.beds.filter((b) => b.admissionId).map((b) => [b.admissionId!, b])), [payload.beds]);
  const overdue = items.filter((i) => i.instance.status === 'overdue' && i.instance.dueAt.getTime() > now - 12 * 3_600_000);
  const tcOverdue = overdue.filter((i) => i.line.timeCritical && !(i.instance.snoozedUntil && i.instance.snoozedUntil.getTime() > now));

  // The chime: a new time-critical dose overdue on a ward tablet, outside quiet hours, not in observe.
  const lastCount = useRef(tcOverdue.length);
  useEffect(() => {
    const quiet = inQuietHours(new Date(now), payload.timezone, payload.settings.quietFrom, payload.settings.quietTo);
    if (isTablet && payload.settings.chime && payload.stage !== 'observe' && !quiet && tcOverdue.length > lastCount.current) beep();
    lastCount.current = tcOverdue.length;
  }, [tcOverdue.length, isTablet, payload.settings, payload.stage, payload.timezone, now]);

  const staleMin = Math.floor((now - syncedAt) / 60_000);
  const syncTone = staleMin >= 15 ? 'bg-red-600 text-white' : staleMin >= 5 ? 'bg-amber-400 text-amber-950' : 'bg-ink-100 text-ink-700';
  const syncedText = new Date(syncedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: payload.timezone });
  const currentSlot = slotOf(new Date(now), payload.timezone);
  const [round, setRound] = useState<number>(currentSlot);
  const time = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: payload.timezone });

  const act = (work: () => Promise<{ ok: true } | { ok: true; message: string } | { ok: false; error: string }>, done?: string) =>
    startTransition(async () => {
      const res = await work();
      if (!res.ok) toast.error('Not saved', res.error);
      else {
        if (done) toast.success(done);
        await refresh();
        router.refresh();
      }
    });

  const snooze = (item: BoardItem) => {
    const reason = window.prompt('Why put this alert off? (e.g. patient at X-ray)');
    if (!reason) return;
    const minutes = Number(window.prompt('For how many minutes? (5 to 30)', '15'));
    act(() => snoozeDynamic({ admissionId: item.line.admissionId, orderId: item.line.orderId, dueAt: item.instance.dueAt.toISOString(), minutes, reason }));
  };

  const doseHref = (item: BoardItem) => `/ipd/admissions/${item.line.admissionId}/treatment?order=${item.line.orderId}&due=${encodeURIComponent(item.instance.dueAt.toISOString())}`;
  const lineName = (item: BoardItem) =>
    item.line.kind === 'task' ? (item.line.taskKind ? `${TASK_KINDS[item.line.taskKind]}: ${item.line.description}` : item.line.description) : `${item.line.description}${item.line.dose ? ` ${item.line.dose}` : ''}`;
  // Open: not acknowledged, and the dose not recorded since.
  const recordedDue = new Set(payload.records.filter((r) => r.dueAt).map((r) => `${r.orderId}|${new Date(r.dueAt!).getTime()}`));
  const openEscalations = payload.escalations.filter((e) => !e.acknowledged && !recordedDue.has(`${e.orderId}|${new Date(e.dueAt).getTime()}`));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-ink-900">{payload.ward.name} · due board</h1>
          <p className="text-sm text-ink-600">
            {overdue.length > 0 ? <strong className="text-red-700">{overdue.length} overdue</strong> : 'Nothing overdue'} ·{' '}
            {items.filter((i) => i.instance.status === 'due_now').length} due now
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', syncTone)} role="status">
            Last synced {syncedText}
            {staleMin >= 5 ? ` · ${staleMin} min ago` : ''}
          </span>
          <Link
            href={`/print/round-list?ward=${payload.ward.id}`}
            target="_blank"
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
          >
            Print round list
          </Link>
        </div>
      </div>

      {payload.stage === 'observe' ? (
        <p className="rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-900">Trial stage: the board shows due times; no chime, banners or escalation yet.</p>
      ) : null}
      {!payload.tcActive ? (
        <p className="rounded-xl bg-ink-100 px-4 py-2 text-xs text-ink-700">Time-critical alerts are off until a doctor signs off the time-critical list (Settings → Treatment and due times).</p>
      ) : null}

      {openEscalations.length > 0 ? (
        <Card>
          <CardHeader title="Escalated" hint="Late time-critical doses passed to the in-charge or the doctor" />
          <ul className="divide-y divide-ink-100">
            {openEscalations.map((e) => {
              const line = lineById.get(e.orderId);
              const bed = line ? bedOf.get(line.admissionId) : undefined;
              return (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-5">
                  <span>
                    <span className="mr-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">L{e.level}</span>
                    Bed {bed?.label} · {bed?.patientName} · {line?.description} · due {time(new Date(e.dueAt))}
                  </span>
                  <Button type="button" variant="secondary" className="h-11" isLoading={pending} onClick={() => act(() => acknowledgeDynamic({ escalationId: e.id }), 'Acknowledged')}>
                    Acknowledge
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {overdue.length > 0 ? (
        <Card>
          <CardHeader title="Overdue now" />
          <ul className="divide-y divide-ink-100">
            {overdue.map((item) => (
              <DueRow now={now} key={`${item.line.orderId}-${item.instance.dueAt.getTime()}`} item={item} bed={bedOf.get(item.line.admissionId)} name={lineName(item)} time={time} href={doseHref(item)} onSnooze={canSnooze && item.line.timeCritical ? () => snooze(item) : null} />
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Phone: one round at a time. */}
      <Card className="md:hidden">
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-4 py-2">
          <button type="button" className="min-h-11 px-2 text-sm font-semibold" onClick={() => setRound(DEFAULT_SLOTS[(DEFAULT_SLOTS.indexOf(round as never) + DEFAULT_SLOTS.length - 1) % DEFAULT_SLOTS.length])}>
            ←
          </button>
          <p className="text-sm font-bold">
            {round === currentSlot ? 'Now: ' : ''}
            {hourLabel(round)} round
          </p>
          <button type="button" className="min-h-11 px-2 text-sm font-semibold" onClick={() => setRound(DEFAULT_SLOTS[(DEFAULT_SLOTS.indexOf(round as never) + 1) % DEFAULT_SLOTS.length])}>
            →
          </button>
        </div>
        {(() => {
          const inRound = items.filter((i) => slotOf(i.instance.dueAt, payload.timezone) === round && i.instance.dueAt >= new Date(now - 14 * 3_600_000) && i.instance.dueAt <= new Date(now + 14 * 3_600_000));
          return inRound.length === 0 ? (
            <EmptyState title="Nothing due in this round" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {inRound.map((item) => (
                <DueRow now={now} key={`${item.line.orderId}-${item.instance.dueAt.getTime()}`} item={item} bed={bedOf.get(item.line.admissionId)} name={lineName(item)} time={time} href={doseHref(item)} onSnooze={canSnooze && item.line.timeCritical ? () => snooze(item) : null} />
              ))}
            </ul>
          );
        })()}
      </Card>

      {/* Tablet and desktop: the paper MAR's time grid. */}
      <Card className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-xs">
            <thead>
              <tr className="bg-ink-50">
                <th className="sticky left-0 z-10 w-56 bg-ink-50 px-2 py-2 text-left font-semibold">Bed · patient · line</th>
                {DEFAULT_SLOTS.map((h) => (
                  <th key={h} className={cn('px-1 py-2 text-center font-semibold', h === currentSlot && 'bg-brand-100 text-brand-900')}>
                    {hourLabel(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.beds
                .filter((b) => b.admissionId)
                .map((bed) => {
                  const lines = payload.lines.filter((l) => l.admissionId === bed.admissionId);
                  return [
                    <tr key={bed.bedId} className="border-t-2 border-ink-200 bg-white">
                      <td colSpan={DEFAULT_SLOTS.length + 1} className="px-2 py-1.5 text-sm font-bold">
                        Bed {bed.label} · {bed.patientName}
                        {bed.detail ? <span className="ml-1 font-normal text-ink-500">{bed.detail}</span> : null}
                      </td>
                    </tr>,
                    ...lines.map((line) => {
                      const mine = items.filter((i) => i.line.orderId === line.orderId && i.instance.dueAt >= new Date(payload.from) && i.instance.dueAt.getTime() >= now - 12 * 3_600_000);
                      return (
                        <tr key={line.orderId} className="border-t border-ink-100">
                          <td className="sticky left-0 z-10 bg-white px-2 py-1.5">
                            {line.timeCritical ? <span className="mr-1 rounded bg-red-100 px-1 font-bold text-red-800">⏰ TC</span> : null}
                            {line.kind === 'task' && line.taskKind ? `${TASK_KINDS[line.taskKind]}: ` : ''}
                            {line.description}
                            {line.dose ? <span className="text-ink-500"> {line.dose}</span> : null}
                          </td>
                          {DEFAULT_SLOTS.map((h) => {
                            const cell = mine.filter((i) => slotOf(i.instance.dueAt, payload.timezone) === h);
                            return (
                              <td key={h} className={cn('px-1 py-1 text-center align-top', h === currentSlot && 'bg-brand-50')}>
                                {cell.map((item) => (
                                  <Link key={item.instance.dueAt.getTime()} href={doseHref(item)} className={cn('mb-0.5 block rounded px-1 py-0.5 font-semibold', cellTone(item))}>
                                    {cellText(item, time)}
                                  </Link>
                                ))}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    }),
                  ];
                })}
            </tbody>
          </table>
        </div>
      </Card>

      {!payload.ratedThisShift && payload.stage !== 'observe' ? <RateShift wardId={payload.ward.id} onDone={() => setPayload({ ...payload, ratedThisShift: true })} /> : null}
    </div>
  );
}

function cellTone(item: BoardItem): string {
  switch (item.instance.status) {
    case 'overdue':
      return item.instance.escalation > 0 && item.line.timeCritical ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950';
    case 'due_now':
      return 'bg-sky-600 text-white';
    case 'due_soon':
      return 'bg-sky-100 text-sky-900';
    case 'given_on_time':
      return 'text-emerald-800';
    case 'given_late':
    case 'given_early':
      return 'text-amber-900';
    case 'not_given':
      return 'text-ink-700';
    default:
      return 'text-ink-500';
  }
}

function cellText(item: BoardItem, time: (d: Date) => string): string {
  const i = item.instance;
  switch (i.status) {
    case 'given_on_time':
      return `✓ ${time(i.record!.occurredAt)}`;
    case 'given_late':
    case 'given_early':
      return `✓* ${time(i.record!.occurredAt)}`;
    case 'not_given':
      return i.record?.state === 'held' ? 'H' : i.record?.state === 'refused' ? 'R' : '✗';
    case 'overdue':
      return `OVERDUE ${i.overdueMin}m`;
    case 'due_now':
      return `DUE ${time(i.dueAt)}`;
    default:
      return time(i.dueAt);
  }
}

function DueRow({
  item,
  bed,
  name,
  time,
  href,
  onSnooze,
  now,
}: {
  now: number;
  item: BoardItem;
  bed: BoardPayload['beds'][number] | undefined;
  name: string;
  time: (d: Date) => string;
  href: string;
  onSnooze: (() => void) | null;
}) {
  const i = item.instance;
  const snoozed = i.snoozedUntil && i.snoozedUntil.getTime() > now;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
      <Link href={href} className="min-w-0 flex-1">
        <p className="text-base font-semibold text-ink-900">
          Bed {bed?.label} · {bed?.patientName}
        </p>
        <p className="text-sm text-ink-800">
          {item.line.timeCritical ? <span className="mr-1 rounded bg-red-100 px-1 text-xs font-bold text-red-800">⏰ TC</span> : null}
          {name} · due {time(i.dueAt)}
        </p>
        {i.closeToPrevious ? <p className="text-xs font-medium text-amber-800">Next dose close to the last one — check with the doctor</p> : null}
        {snoozed ? <p className="text-xs text-ink-500">Put off until {time(i.snoozedUntil!)}</p> : null}
      </Link>
      <span className="flex items-center gap-2">
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', cellTone(item))}>
          {i.status === 'overdue' ? `OVERDUE ${i.overdueMin} min` : STATUS_TEXT[i.status]}
        </span>
        {onSnooze && (i.status === 'overdue' || i.status === 'due_now') && !snoozed ? (
          <button type="button" onClick={onSnooze} className="min-h-11 rounded-lg px-2 text-xs font-medium text-ink-600 hover:bg-ink-100">
            Snooze
          </button>
        ) : null}
      </span>
    </li>
  );
}

function RateShift({ wardId, onDone }: { wardId: string; onDone: () => void }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const rate = (rating: string) =>
    startTransition(async () => {
      const res = await rateAlertsDynamic({ wardId, rating });
      if (!res.ok) toast.error('Not saved', res.error);
      else {
        toast.success('Thank you');
        onDone();
      }
    });
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <p className="text-sm font-medium">How were the alerts this shift?</p>
        <span className="flex gap-2">
          {[
            ['too_many', 'Too many'],
            ['about_right', 'About right'],
            ['too_few', 'Too few'],
          ].map(([value, label]) => (
            <Button key={value} type="button" variant="secondary" className="h-11" disabled={pending} onClick={() => rate(value)}>
              {label}
            </Button>
          ))}
        </span>
      </div>
    </Card>
  );
}
