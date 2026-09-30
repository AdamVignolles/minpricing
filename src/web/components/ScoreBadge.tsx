import type { FC } from "react";

export interface ScoreBadgeProps {
  score: number;
}

/**
 * Colored pill for a deal's relevance score (see ScoringService).
 */
const ScoreBadge: FC<ScoreBadgeProps> = ({ score }) => {
  const color =
    score >= 70
      ? "bg-emerald-100 text-emerald-800"
      : score >= 50
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-600";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
      {score}/100
    </span>
  );
};

export default ScoreBadge;
