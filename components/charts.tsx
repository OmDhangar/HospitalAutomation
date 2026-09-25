import { cn } from './ui';

/**
 * Charts as plain server-rendered SVG.
 *
 * No charting library on purpose. Recharts and its peers are 80-150 KB of
 * JavaScript that arrive before the first pixel, and every one of them forces
 * the surrounding page into a client component — which would give up the
 * streaming server render the rest of this dashboard depends on. What is drawn
 * here is a handful of rectangles and a polyline; the library would be almost
 * entirely overhead, paid on a reception desktop over a clinic's connection.
 *
 * Hover is native SVG <title>, so every mark is inspectable with zero bytes of
 * script. That is a deliberate trade: no crosshair and no styled tooltip, in
 * exchange for a chart that costs nothing to ship and renders identically when
 * the page is printed — which is how a lot of these actually reach a doctor.
 *
 * Palette is validated (see the dataviz validator): teal #0d9488, rose #e11d48,
 * amber #d97706 pass lightness, chroma, CVD separation and contrast against a
 * white surface. Every series is also direct-labelled or legended, so identity
 * never rests on colour alone.
 */

const SERIES = {
  primary: '#0d9488', // brand-600 — volume, the thing being counted
  negative: '#e11d48', // rose-600 — no-shows
  attention: '#d97706', // amber-600 — waiting time
} as const;

/* ------------------------------------------------------------- utilities */

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

const DAY_LABEL = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

function shortDate(iso: string): string {
  // Parsed as UTC noon so a timezone shift cannot roll the label to the
  // previous day, which is the classic off-by-one in date-only charts.
  return DAY_LABEL.format(new Date(`${iso}T12:00:00Z`));
}

/* ------------------------------------------------------------- trend */

export type TrendPoint = {
  serviceDate: string;
  completed: number;
  noShows: number;
  medianWaitMinutes: number | null;
};

/**
 * Daily patient volume, with no-shows stacked beneath.
 *
 * Bars rather than a line: each day is a discrete count the reader compares
 * against its neighbours, not a continuous quantity sampled over time. Stacking
 * no-shows under completed keeps the total height meaningful as "people who had
 * an appointment" while still separating the two.
 */
export function VolumeTrend({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return null;

  const max = niceCeiling(Math.max(...data.map((d) => d.completed + d.noShows), 1));

  // A viewBox with no fixed width: the SVG scales to its container, so the
  // chart cannot overflow the card on a narrow window.
  const W = 720;
  const H = 180;
  const padY = 8;
  const plotH = H - padY - 22;
  const slot = W / data.length;
  const barW = Math.max(2, Math.min(18, slot - 3));

  const gridLines = [0, 0.5, 1].map((fraction) => ({
    y: padY + plotH * (1 - fraction),
    value: Math.round(max * fraction),
  }));

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-44 w-full"
        role="img"
        aria-label={`Daily patient volume over ${data.length} days`}
        preserveAspectRatio="none"
      >
        {gridLines.map((line) => (
          <g key={line.value}>
            <line
              x1={0}
              x2={W}
              y1={line.y}
              y2={line.y}
              stroke="#e2e8f0"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}

        {data.map((point, index) => {
          const total = point.completed + point.noShows;
          const x = index * slot + (slot - barW) / 2;
          const completedH = (point.completed / max) * plotH;
          const noShowH = (point.noShows / max) * plotH;
          const baseY = padY + plotH;

          return (
            <g key={point.serviceDate}>
              <title>
                {`${shortDate(point.serviceDate)}: ${point.completed} seen` +
                  (point.noShows > 0 ? `, ${point.noShows} no-show` : '') +
                  (point.medianWaitMinutes !== null
                    ? `, ${point.medianWaitMinutes}m median wait`
                    : '')}
              </title>

              {/* No-shows sit at the base, completed above — a 2px gap between
                  the two fills keeps the boundary readable when both are small. */}
              {point.noShows > 0 ? (
                <rect
                  x={x}
                  y={baseY - noShowH}
                  width={barW}
                  height={noShowH}
                  fill={SERIES.negative}
                  rx={1}
                />
              ) : null}
              {point.completed > 0 ? (
                <rect
                  x={x}
                  y={baseY - noShowH - completedH - (point.noShows > 0 ? 2 : 0)}
                  width={barW}
                  height={completedH}
                  fill={SERIES.primary}
                  rx={2}
                />
              ) : null}
              {total === 0 ? (
                <rect x={x} y={baseY - 2} width={barW} height={2} fill="#e2e8f0" rx={1} />
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="mt-1 flex items-center justify-between text-xs text-ink-400">
        <span>{shortDate(data[0].serviceDate)}</span>
        <span className="text-ink-500">Peak {max} / day</span>
        <span>{shortDate(data[data.length - 1].serviceDate)}</span>
      </div>
    </figure>
  );
}

/* --------------------------------------------------------- hourly load */

export type HourPoint = { hour: number; arrivals: number };

/**
 * Arrivals by hour of day — the shape of the clinic's own working day.
 *
 * Only the hours that actually see patients are drawn. A clinic running 9-2 and
 * 5-8 should not be handed nineteen empty columns to read past; the busiest
 * hour is the answer, and the empty night is noise.
 */
export function HourlyLoad({ data }: { data: HourPoint[] }) {
  const active = data.filter((d) => d.arrivals > 0);
  if (active.length === 0) return null;

  const first = Math.max(0, Math.min(...active.map((d) => d.hour)) - 1);
  const last = Math.min(23, Math.max(...active.map((d) => d.hour)) + 1);
  const window = data.filter((d) => d.hour >= first && d.hour <= last);

  const max = Math.max(...window.map((d) => d.arrivals), 1);
  const busiest = window.reduce((a, b) => (b.arrivals > a.arrivals ? b : a));

  const hourLabel = (hour: number) => {
    const suffix = hour < 12 ? 'am' : 'pm';
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${twelve}${suffix}`;
  };

  return (
    <figure className="m-0">
      <div className="flex items-end gap-1" style={{ height: 120 }}>
        {window.map((point) => {
          const isPeak = point.hour === busiest.hour;
          const heightPercent = (point.arrivals / max) * 100;

          return (
            <div
              key={point.hour}
              className="group flex min-w-0 flex-1 flex-col justify-end"
              title={`${hourLabel(point.hour)} — ${point.arrivals} patient${
                point.arrivals === 1 ? '' : 's'
              }`}
            >
              <div
                className={cn(
                  'w-full rounded-t-sm transition-colors',
                  isPeak ? 'bg-amber-600' : 'bg-brand-600/70 group-hover:bg-brand-600',
                )}
                // Minimum 2px so a low-but-nonzero hour stays visible rather
                // than collapsing into the axis and reading as closed.
                style={{ height: `max(2px, ${heightPercent}%)` }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex gap-1">
        {window.map((point) => (
          <div key={point.hour} className="min-w-0 flex-1 text-center">
            {/* Every third hour, so labels never collide on a narrow card. */}
            {point.hour % 3 === 0 ? (
              <span className="text-[10px] text-ink-400">{hourLabel(point.hour)}</span>
            ) : null}
          </div>
        ))}
      </div>

      <figcaption className="mt-3 text-sm text-ink-600">
        Busiest at{' '}
        <strong className="text-ink-900">{hourLabel(busiest.hour)}</strong> —{' '}
        {busiest.arrivals} arrivals over the period.
      </figcaption>
    </figure>
  );
}

/* --------------------------------------------------------------- legend */

export function Legend({
  items,
}: {
  items: Array<{ color: string; label: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-sm"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-xs text-ink-500">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

export const CHART_COLORS = SERIES;

/* ----------------------------------------------------------- comparison */

/**
 * A number with its own recent history attached.
 *
 * A figure on its own invites the question "is that good?", and a reader who
 * cannot answer it stops reading. The delta answers it in place.
 */
export function TrendStat({
  label,
  value,
  previous,
  suffix = '',
  /** Whether a rising number is good. False for no-shows and waiting time. */
  higherIsBetter = true,
  hint,
}: {
  label: string;
  value: number | null;
  previous: number | null;
  suffix?: string;
  higherIsBetter?: boolean;
  hint?: string;
}) {
  const hasBoth = value !== null && previous !== null && previous > 0;
  const changePercent = hasBoth ? Math.round(((value - previous) / previous) * 100) : null;

  // A change under 5% on clinic-sized numbers is noise, and colouring it green
  // or red invites a reader to act on a rounding difference.
  const material = changePercent !== null && Math.abs(changePercent) >= 5;
  const good = changePercent !== null && changePercent > 0 === higherIsBetter;

  return (
    <div className="p-3.5 sm:px-5 sm:py-4">
      <p className="text-[11px] sm:text-xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className="numeric mt-1 text-xl sm:text-2xl font-bold text-ink-900">
        {value === null ? '—' : value.toLocaleString('en-IN')}
        {value !== null && suffix ? (
          <span className="ml-0.5 text-sm sm:text-base font-normal text-ink-500">{suffix}</span>
        ) : null}
      </p>
      {changePercent !== null && material ? (
        <p
          className={cn(
            'mt-1 text-[11px] sm:text-xs font-semibold truncate',
            good ? 'text-emerald-700' : 'text-rose-700',
          )}
        >
          {changePercent > 0 ? '▲' : '▼'} {Math.abs(changePercent)}% vs prev
        </p>
      ) : (
        <p className="mt-1 text-[11px] sm:text-xs text-ink-400 truncate">{hint ?? 'In line with prev'}</p>
      )}
    </div>
  );
}
