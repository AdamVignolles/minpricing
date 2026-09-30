import type { FC } from "react";

export interface PricePoint {
  price: number;
  observedAt: string;
}

export interface PriceHistoryChartProps {
  points: PricePoint[];
  currency: string;
}

const WIDTH = 600;
const HEIGHT = 160;
const PADDING = 24;

/**
 * A minimal dependency-free line chart. Good enough for a handful of price
 * points; not meant to replace a charting library if this grows.
 */
const PriceHistoryChart: FC<PriceHistoryChartProps> = ({
  points,
  currency,
}) => {
  if (points.length === 0) {
    return (
      <p className="text-sm text-slate-500">Pas encore d'historique de prix.</p>
    );
  }

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const coords = points.map((point, index) => {
    const x =
      points.length === 1
        ? WIDTH / 2
        : PADDING + (index / (points.length - 1)) * (WIDTH - 2 * PADDING);
    const y =
      HEIGHT - PADDING - ((point.price - min) / range) * (HEIGHT - 2 * PADDING);
    return { x, y };
  });

  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-sky-600">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={3} fill="currentColor" />
      ))}
      <text x={PADDING} y={16} className="fill-slate-500 text-[10px]">
        max {max.toFixed(2)} {currency}
      </text>
      <text x={PADDING} y={HEIGHT - 8} className="fill-slate-500 text-[10px]">
        min {min.toFixed(2)} {currency}
      </text>
    </svg>
  );
};

export default PriceHistoryChart;
