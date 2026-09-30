import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import type { FC } from "react";
import { useState } from "react";

import type { DraftsController } from "../../api/controllers/DraftsController.ts";
import Nav from "./Nav.tsx";
import PriceHistoryChart from "./PriceHistoryChart.tsx";
import ScoreBadge from "./ScoreBadge.tsx";

interface Deal {
  id: string;
  title: string;
  url: string;
  imageUrl?: string;
  currentPrice: number;
  oldPrice?: number;
  currency: string;
  discountPercentage?: number;
  score: number;
  status: string;
  availability: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface PricePoint {
  price: number;
  observedAt: string;
}

interface Draft {
  id: string;
  title: string;
  body: string;
  status: "draft" | "posted" | "discarded";
}

export interface DealDetailPageProps {
  deal: Deal;
  history: PricePoint[];
  draft: Draft | null;
}

const DealDetailPage: FC<DealDetailPageProps> = ({ deal, history, draft }) => {
  const drafts = useClient<DraftsController>();
  const [current, setCurrent] = useState(draft);
  const [saving, setSaving] = useState(false);

  const save = async (patch: Partial<Draft>) => {
    if (!current) return;
    setSaving(true);
    try {
      const updated = await drafts.update({
        params: { id: deal.id },
        body: patch,
      });
      setCurrent(updated);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = async () => {
    if (!current) return;
    await navigator.clipboard.writeText(`${current.title}\n\n${current.body}`);
  };

  return (
    <Nav>
      <Link href="/" className="text-sm text-sky-600 underline">
        ← Retour aux deals
      </Link>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{deal.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Vu la 1ère fois le {new Date(deal.firstSeenAt).toLocaleDateString()}
            , dernière vérification le{" "}
            {new Date(deal.lastSeenAt).toLocaleString()}.
          </p>
        </div>
        <ScoreBadge score={deal.score} />
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <span className="text-3xl font-bold">
          {deal.currentPrice.toFixed(2)} {deal.currency}
        </span>
        {deal.oldPrice !== undefined && deal.oldPrice > deal.currentPrice && (
          <span className="text-lg text-slate-400 line-through">
            {deal.oldPrice.toFixed(2)} {deal.currency}
          </span>
        )}
        {deal.discountPercentage !== undefined &&
          deal.discountPercentage > 0 && (
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-sm text-emerald-800">
              -{deal.discountPercentage}%
            </span>
          )}
      </div>

      <a
        href={deal.url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-sm text-sky-600 underline"
      >
        Voir l'offre originale
      </a>

      <section className="mt-6 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Historique des prix</h2>
        <PriceHistoryChart points={history} currency={deal.currency} />
      </section>

      <section className="mt-6 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Brouillon Dealabs</h2>
        {!current ? (
          <p className="text-sm text-slate-500">
            Pas encore de brouillon généré : le score doit dépasser 50/100 lors
            d'une collecte pour qu'un brouillon soit créé automatiquement.
          </p>
        ) : (
          <div className="space-y-3">
            <input
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm font-medium"
              value={current.title}
              onChange={(e) =>
                setCurrent({ ...current, title: e.target.value })
              }
              onBlur={(e) => save({ title: e.target.value })}
            />
            <textarea
              className="h-40 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={current.body}
              onChange={(e) => setCurrent({ ...current, body: e.target.value })}
              onBlur={(e) => save({ body: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyToClipboard}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
              >
                Copier
              </button>
              <select
                className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                value={current.status}
                onChange={(e) => {
                  const status = e.target.value as Draft["status"];
                  setCurrent({ ...current, status });
                  void save({ status });
                }}
              >
                <option value="draft">À relire</option>
                <option value="posted">Posté sur Dealabs</option>
                <option value="discarded">Ignoré</option>
              </select>
              {saving && (
                <span className="text-xs text-slate-400">
                  Enregistrement...
                </span>
              )}
            </div>
          </div>
        )}
      </section>
    </Nav>
  );
};

export default DealDetailPage;
