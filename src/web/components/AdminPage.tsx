import { useClient } from "alepha/react";
import type { FC, FormEvent } from "react";
import { useState } from "react";

import type { AdminController } from "../../api/controllers/AdminController.ts";
import type { ProductsController } from "../../api/controllers/ProductsController.ts";
import Nav from "./Nav.tsx";

interface SourceStat {
  id: string;
  name: string;
  enabled: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

interface Stats {
  activeDeals: number;
  expiredDeals: number;
  draftsPending: number;
  sources: SourceStat[];
}

interface Product {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  manualPrice?: number;
  steamAppId?: number;
  currency: string;
}

export interface AdminPageProps {
  stats: Stats;
  products: Product[];
}

const AdminPage: FC<AdminPageProps> = ({
  stats: initialStats,
  products: initialProducts,
}) => {
  const admin = useClient<AdminController>();
  const productsClient = useClient<ProductsController>();

  const [stats, setStats] = useState(initialStats);
  const [products, setProducts] = useState(initialProducts);
  const [running, setRunning] = useState(false);

  const [form, setForm] = useState({
    sourceId: "manual",
    title: "",
    url: "",
    manualPrice: "",
    steamAppId: "",
  });

  const refreshStats = async () => {
    setStats(await admin.stats({}));
  };

  const runCollectNow = async () => {
    setRunning(true);
    try {
      await admin.collectNow({});
      await refreshStats();
      setProducts(await productsClient.listProducts({ query: {} }));
    } finally {
      setRunning(false);
    }
  };

  const addProduct = async (e: FormEvent) => {
    e.preventDefault();
    const created = await productsClient.create({
      body: {
        sourceId: form.sourceId,
        title: form.title,
        url: form.url,
        manualPrice: form.manualPrice ? Number(form.manualPrice) : undefined,
        steamAppId: form.steamAppId ? Number(form.steamAppId) : undefined,
      },
    });
    setProducts([...products, created]);
    setForm({
      sourceId: "manual",
      title: "",
      url: "",
      manualPrice: "",
      steamAppId: "",
    });
  };

  const updateManualPrice = async (id: string, manualPrice: string) => {
    if (!manualPrice) return;
    const updated = await productsClient.updateManualPrice({
      params: { id },
      body: { manualPrice: Number(manualPrice) },
    });
    setProducts(products.map((p) => (p.id === id ? updated : p)));
    await refreshStats();
  };

  return (
    <Nav>
      <h1 className="mb-4 text-2xl font-bold">Administration</h1>

      <section className="mb-6 grid grid-cols-3 gap-3">
        <div className="rounded border border-slate-200 bg-white p-4">
          <p className="text-2xl font-bold">{stats.activeDeals}</p>
          <p className="text-sm text-slate-500">Deals actifs</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4">
          <p className="text-2xl font-bold">{stats.expiredDeals}</p>
          <p className="text-sm text-slate-500">Deals expirés</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4">
          <p className="text-2xl font-bold">{stats.draftsPending}</p>
          <p className="text-sm text-slate-500">Brouillons à relire</p>
        </div>
      </section>

      <button
        type="button"
        onClick={runCollectNow}
        disabled={running}
        className="mb-6 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {running ? "Collecte en cours..." : "Lancer la collecte maintenant"}
      </button>

      <section className="mb-6 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Sources</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-1">Source</th>
              <th className="pb-1">Dernière exécution</th>
              <th className="pb-1">Dernier succès</th>
              <th className="pb-1">Dernière erreur</th>
            </tr>
          </thead>
          <tbody>
            {stats.sources.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-1">{s.name}</td>
                <td className="py-1">
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}
                </td>
                <td className="py-1">
                  {s.lastSuccessAt
                    ? new Date(s.lastSuccessAt).toLocaleString()
                    : "—"}
                </td>
                <td className="py-1 text-red-600">{s.lastError ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-6 rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Ajouter un produit à suivre</h2>
        <p className="mb-2 text-xs text-slate-500">
          Amazon et Cdiscount sont maintenant découverts automatiquement (page
          bons plans scrapée à chaque collecte) : inutile de les ajouter ici. Ce
          formulaire reste utile pour suivre un produit précis en manuel ou un
          jeu Steam donné.
        </p>
        <form onSubmit={addProduct} className="grid grid-cols-2 gap-2">
          <select
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={form.sourceId}
            onChange={(e) => setForm({ ...form, sourceId: e.target.value })}
          >
            <option value="manual">Manuel (Amazon/Cdiscount)</option>
            <option value="steam">Steam</option>
          </select>
          <input
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Titre"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <input
            className="col-span-2 rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="URL du produit"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            required
          />
          {form.sourceId === "manual" ? (
            <input
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="Prix observé (€)"
              type="number"
              step="0.01"
              value={form.manualPrice}
              onChange={(e) =>
                setForm({ ...form, manualPrice: e.target.value })
              }
            />
          ) : (
            <input
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="Steam App ID"
              type="number"
              value={form.steamAppId}
              onChange={(e) => setForm({ ...form, steamAppId: e.target.value })}
            />
          )}
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white"
          >
            Ajouter
          </button>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Produits suivis</h2>
        <ul className="space-y-2">
          {products.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>
                {p.title} <span className="text-slate-400">({p.sourceId})</span>
              </span>
              {p.sourceId === "manual" ? (
                <input
                  className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
                  type="number"
                  step="0.01"
                  placeholder={
                    p.manualPrice ? `${p.manualPrice}` : "Prix observé"
                  }
                  onBlur={(e) => updateManualPrice(p.id, e.target.value)}
                />
              ) : (
                <span className="text-slate-400">App ID {p.steamAppId}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Nav>
  );
};

export default AdminPage;
