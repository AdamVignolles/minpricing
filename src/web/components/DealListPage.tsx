import { useRouter } from "alepha/react/router";
import { Link } from "alepha/react/router";
import type { FC } from "react";

import Nav from "./Nav.tsx";
import ScoreBadge from "./ScoreBadge.tsx";

interface Deal {
  id: string;
  title: string;
  url: string;
  currentPrice: number;
  oldPrice?: number;
  currency: string;
  discountPercentage?: number;
  score: number;
  status: string;
  categoryId?: string;
  merchantId?: string;
  sourceId: string;
}

interface RefItem {
  id: string;
  name: string;
}

export interface DealListPageProps {
  dealsPage: {
    content: Deal[];
    page: { number: number; size: number; totalElements?: number };
  };
  categories: RefItem[];
  merchants: RefItem[];
  sources: RefItem[];
  query: {
    status?: string;
    minScore?: number;
    categoryId?: string;
    merchantId?: string;
    sourceId?: string;
    search?: string;
  };
}

const DealListPage: FC<DealListPageProps> = ({
  dealsPage,
  categories,
  merchants,
  sources,
  query,
}) => {
  const router = useRouter();

  const setFilter = (key: string, value: string) => {
    router.setQueryParams((current) => {
      const next = { ...current };
      if (value) {
        next[key] = value;
      } else {
        delete next[key];
      }
      delete next.page;
      return next;
    });
  };

  return (
    <Nav>
      <h1 className="mb-4 text-2xl font-bold">Bons plans suivis</h1>

      <div className="mb-6 flex flex-wrap gap-3">
        <input
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Rechercher..."
          defaultValue={query.search ?? ""}
          onBlur={(e) => setFilter("search", e.target.value)}
        />
        <select
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          defaultValue={query.status ?? ""}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          <option value="">Tous statuts</option>
          <option value="active">Actif</option>
          <option value="expired">Expiré</option>
          <option value="archived">Archivé</option>
        </select>
        <select
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          defaultValue={query.categoryId ?? ""}
          onChange={(e) => setFilter("categoryId", e.target.value)}
        >
          <option value="">Toutes catégories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          defaultValue={query.merchantId ?? ""}
          onChange={(e) => setFilter("merchantId", e.target.value)}
        >
          <option value="">Tous marchands</option>
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          defaultValue={query.sourceId ?? ""}
          onChange={(e) => setFilter("sourceId", e.target.value)}
        >
          <option value="">Toutes sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {dealsPage.content.length === 0 ? (
        <p className="text-slate-500">
          Aucun deal pour ces filtres. Ajoute des produits à suivre depuis la
          page{" "}
          <Link href="/admin" className="text-sky-600 underline">
            Admin
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {dealsPage.content.map((deal) => (
            <li key={deal.id}>
              <Link
                href={`/deals/${deal.id}`}
                className="flex items-center justify-between rounded border border-slate-200 bg-white px-4 py-3 hover:border-sky-400"
              >
                <div>
                  <p className="font-medium">{deal.title}</p>
                  <p className="text-sm text-slate-500">
                    {deal.currentPrice.toFixed(2)} {deal.currency}
                    {deal.oldPrice !== undefined &&
                      deal.oldPrice > deal.currentPrice && (
                        <>
                          {" "}
                          <span className="text-slate-400 line-through">
                            {deal.oldPrice.toFixed(2)} {deal.currency}
                          </span>
                          {deal.discountPercentage !== undefined && (
                            <span className="ml-1 text-emerald-700">
                              -{deal.discountPercentage}%
                            </span>
                          )}
                        </>
                      )}
                  </p>
                </div>
                <ScoreBadge score={deal.score} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-slate-400">
        {dealsPage.page.totalElements ?? dealsPage.content.length} deal(s) au
        total.
      </p>
    </Nav>
  );
};

export default DealListPage;
