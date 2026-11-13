import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import {
  type CatalogProduct,
  readProductPage,
  readShopifyProducts,
  readSitemap,
  robotsAllows,
} from "../collectors/catalogReaders.ts";
import {
  catalogOfferEntity,
  catalogPriceEntity,
} from "../entities/CatalogOffer.ts";
import {
  type CatalogSource,
  DEFAULT_ACTIVE_HOURS,
  isKidsProduct,
  loadCatalogConfig,
  pauseMsOf,
  perRunOf,
  wantedTitle,
  wantedUrls,
} from "./catalogSources.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

/** Sub-sitemaps followed from an index, and URLs kept per shop. */
const MAX_SITEMAPS = 60;
const MAX_URLS = 40_000;
/** The URL list of a shop is refreshed at most this often. */
const SITEMAP_TTL_MS = 20 * 3_600_000;
/** After this many failed reads in a row a page is left alone. */
const MAX_READ_FAILURES = 5;
const SHOPIFY_MAX_PAGES = 20;

export interface PageAnswer {
  status: number;
  body: string;
}

export interface CatalogPass {
  sourceId: string;
  /** New pages the sitemap named this pass. */
  discovered: number;
  read: number;
  kept: number;
  skipped: number;
  gone: number;
  failed: number;
  priceChanges: number;
  /** Why the pass stopped early (« 403 : la boutique refuse »), if it did. */
  stopped?: string;
}

export interface CatalogProbe {
  sourceId: string;
  ok: boolean;
  robots: "ok" | "absent";
  sitemapUrls: number;
  wantedUrls: number;
  samples: Array<{
    url: string;
    status: number;
    product: boolean;
    title?: string;
    price?: number;
    ean?: string;
    reference?: string;
    kept?: boolean;
  }>;
  problem?: string;
}

/** Paris hour (0–23) of a date. */
export function parisHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Europe/Paris",
    })
      .formatToParts(date)
      .find((part) => part.type === "hour")?.value,
  );
}

/**
 * Reads whole shop catalogues for an outside comparator (the watch site),
 * apart from the deals pipeline: rows go to `catalog_offers`, served by
 * `/feed/catalog`, and never to `deals` — no quality gate, score or
 * Dealabs draft. Gentle on purpose: only at night (`activeHours`), one
 * shop at a time, one request every `pauseSeconds`, a page budget per
 * pass, `robots.txt` obeyed, and a shop that answers 403/429 is left
 * alone until the next pass — never worked around.
 */
export class CatalogService {
  protected log = $logger();
  protected offers = $repository(catalogOfferEntity);
  protected prices = $repository(catalogPriceEntity);
  /** Sources whose pass is under way (each shop runs on its own). */
  protected running = new Set<string>();
  protected sitemapReadAt = new Map<string, number>();

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async fetchPage(url: string): Promise<PageAnswer> {
    const response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(25_000),
    });
    return { status: response.status, body: await response.text() };
  }

  protected config() {
    return loadCatalogConfig();
  }

  /**
   * Runs the sources that are verified and enabled, side by side: each
   * shop keeps its own pace (`pauseSeconds`), so reading several shops at
   * once asks no shop more, and every price can be read again within a
   * day. A shop whose previous pass is still running is left to finish.
   */
  async runDue(now = new Date(), force = false): Promise<CatalogPass[]> {
    const config = this.config();
    const hours = config.activeHours ?? DEFAULT_ACTIVE_HOURS;
    if (!force && !hours.includes(parisHour(now))) return [];
    const due = config.sources.filter(
      (source) =>
        source.verified && source.enabled && !this.running.has(source.id),
    );
    const passes = await Promise.all(
      due.map(async (source) => {
        this.running.add(source.id);
        try {
          return await this.runSource(source, now);
        } catch (error) {
          // One shop failing never stops the others.
          this.log.warn("Catalogue: source failed", {
            source: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        } finally {
          this.running.delete(source.id);
        }
      }),
    );
    return passes.filter((pass): pass is CatalogPass => !!pass);
  }

  async runSource(
    source: CatalogSource,
    now = new Date(),
  ): Promise<CatalogPass> {
    const pass: CatalogPass = {
      sourceId: source.id,
      discovered: 0,
      read: 0,
      kept: 0,
      skipped: 0,
      gone: 0,
      failed: 0,
      priceChanges: 0,
    };
    if (source.reader === "shopify") {
      await this.runShopify(source, pass, now);
    } else {
      await this.runSitemap(source, pass, now);
    }
    this.log.info("Catalogue pass", pass);
    return pass;
  }

  // ------------------------------------------------------------ sitemap

  protected async robots(source: CatalogSource): Promise<string> {
    try {
      const answer = await this.fetchPage(`${source.origin}/robots.txt`);
      return answer.status === 200 ? answer.body : "";
    } catch {
      return "";
    }
  }

  /** Every product URL the shop's sitemaps name, filtered for this source. */
  protected async sitemapUrls(
    source: CatalogSource,
    robots: string,
  ): Promise<{ all: number; wanted: string[] }> {
    const fromRobots = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)]
      .map((match) => match[1])
      .filter((url) => {
        try {
          return new URL(url).origin === new URL(source.origin).origin;
        } catch {
          return false;
        }
      });
    const queue = [
      ...(source.sitemaps?.length
        ? source.sitemaps
        : fromRobots.length
          ? fromRobots
          : [`${source.origin}/sitemap.xml`]),
    ];
    const filter = source.sitemapFilter
      ? new RegExp(source.sitemapFilter, "i")
      : undefined;
    const pages: string[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    while (
      queue.length > 0 &&
      fetched < MAX_SITEMAPS &&
      pages.length < MAX_URLS
    ) {
      const url = queue.shift() as string;
      if (seen.has(url)) continue;
      seen.add(url);
      if (fetched > 0) await this.sleep(pauseMsOf(source));
      fetched++;
      let answer: PageAnswer;
      try {
        answer = await this.fetchPage(url);
      } catch {
        continue;
      }
      if (answer.status !== 200) continue;
      const sitemap = readSitemap(answer.body);
      if (sitemap.index) {
        queue.push(
          ...sitemap.urls.filter((sub) => !filter || filter.test(sub)),
        );
      } else {
        pages.push(...sitemap.urls);
      }
    }
    return {
      all: pages.length,
      wanted: wantedUrls(source, pages).slice(0, MAX_URLS),
    };
  }

  protected async runSitemap(
    source: CatalogSource,
    pass: CatalogPass,
    now: Date,
  ): Promise<void> {
    const robots = await this.robots(source);
    let known = await this.offers.findMany({
      where: { sourceId: { eq: source.id } },
    });

    const lastList = this.sitemapReadAt.get(source.id) ?? 0;
    if (now.getTime() - lastList > SITEMAP_TTL_MS) {
      const { wanted } = await this.sitemapUrls(source, robots);
      const knownIds = new Set(known.map((row) => row.externalId));
      const fresh = wanted.filter((url) => !knownIds.has(url));
      for (let i = 0; i < fresh.length; i += 200) {
        await this.offers.createMany(
          fresh.slice(i, i + 200).map((url) => ({
            sourceId: source.id,
            externalId: url,
            url,
            firstSeenAt: now.toISOString(),
          })),
        );
      }
      if (fresh.length > 0) {
        known = await this.offers.findMany({
          where: { sourceId: { eq: source.id } },
        });
      }
      pass.discovered = fresh.length;
      this.sitemapReadAt.set(source.id, now.getTime());
    }

    const staleBefore = now.getTime() - (source.everyHours ?? 24) * 3_600_000;
    const readAt = (row: (typeof known)[number]) =>
      row.lastReadAt ? new Date(row.lastReadAt).getTime() : 0;
    const due = known
      .filter(
        (row) =>
          (row.status === "pending" || row.status === "active") &&
          row.readFailures < MAX_READ_FAILURES &&
          readAt(row) < staleBefore,
      )
      // Prices of known products first (that is the history), then new pages.
      .sort(
        (a, b) =>
          Number(a.status === "pending") - Number(b.status === "pending") ||
          readAt(a) - readAt(b),
      )
      .slice(0, perRunOf(source));

    for (const [index, row] of due.entries()) {
      if (index > 0) await this.sleep(pauseMsOf(source));
      const path = new URL(row.url).pathname;
      if (!robotsAllows(robots, path)) {
        await this.offers.updateById(row.id, {
          status: "skipped",
          lastReadAt: now.toISOString(),
        });
        pass.skipped++;
        continue;
      }
      let answer: PageAnswer;
      try {
        answer = await this.fetchPage(row.url);
      } catch {
        await this.failed(row, now, pass);
        continue;
      }
      pass.read++;
      if (answer.status === 403 || answer.status === 429) {
        pass.stopped = `${answer.status} : la boutique refuse, lecture arrêtée jusqu'au prochain passage`;
        break;
      }
      if (answer.status === 404 || answer.status === 410) {
        await this.offers.updateById(row.id, {
          status: "gone",
          availability: "out_of_stock",
          lastReadAt: now.toISOString(),
        });
        pass.gone++;
        continue;
      }
      const product =
        answer.status === 200 ? readProductPage(answer.body) : undefined;
      if (!product) {
        await this.failed(row, now, pass);
        continue;
      }
      if (
        !wantedTitle(source, product.title) ||
        isKidsProduct(product.title, product.specs)
      ) {
        await this.offers.updateById(row.id, {
          status: "skipped",
          title: product.title.slice(0, 1000),
          lastReadAt: now.toISOString(),
        });
        pass.skipped++;
        continue;
      }
      await this.store(row, product, now, pass);
    }
  }

  protected async failed(
    row: { id: string; readFailures: number },
    now: Date,
    pass: CatalogPass,
  ): Promise<void> {
    await this.offers.updateById(row.id, {
      readFailures: row.readFailures + 1,
      lastReadAt: now.toISOString(),
    });
    pass.failed++;
  }

  /** Saves what a read said; a price row only when the price changed. */
  protected async store(
    row: { id: string; price?: number },
    product: CatalogProduct,
    now: Date,
    pass: CatalogPass,
  ): Promise<void> {
    const cut = (value: string | undefined, max: number) =>
      value ? value.slice(0, max) : undefined;
    await this.offers.updateById(row.id, {
      status: "active",
      title: cut(product.title, 1000),
      brand: cut(product.brand, 200),
      reference: cut(product.reference, 200),
      sku: cut(product.sku, 200),
      ean: product.ean,
      imageUrl: cut(product.imageUrl, 2000),
      description: product.description,
      // A read without a table keeps what an earlier read found.
      ...(product.specs?.length
        ? { specs: JSON.stringify(product.specs.slice(0, 40)) }
        : {}),
      price: product.price,
      listPrice:
        product.listPrice !== undefined &&
        product.price !== undefined &&
        product.listPrice > product.price
          ? product.listPrice
          : undefined,
      currency: cut(product.currency, 8),
      availability: product.availability ?? "unknown",
      rating: product.rating,
      reviewCount: product.reviewCount,
      readFailures: 0,
      lastReadAt: now.toISOString(),
    });
    pass.kept++;
    if (product.price !== undefined && product.price !== row.price) {
      await this.prices.create({
        offerId: row.id,
        price: product.price,
        observedAt: now.toISOString(),
      });
      if (row.price !== undefined) pass.priceChanges++;
    }
  }

  // ------------------------------------------------------------ shopify

  protected async runShopify(
    source: CatalogSource,
    pass: CatalogPass,
    now: Date,
  ): Promise<void> {
    const robots = await this.robots(source);
    if (!robotsAllows(robots, "/products.json")) {
      pass.stopped = "robots.txt interdit /products.json";
      return;
    }
    const known = new Map<
      string,
      { id: string; price?: number; status: string }
    >(
      (
        await this.offers.findMany({ where: { sourceId: { eq: source.id } } })
      ).map((row) => [
        row.externalId,
        { id: row.id, price: row.price, status: row.status },
      ]),
    );
    const seen = new Set<string>();
    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
      if (page > 1) await this.sleep(pauseMsOf(source));
      let answer: PageAnswer;
      try {
        answer = await this.fetchPage(
          `${source.origin}/products.json?limit=250&page=${page}`,
        );
      } catch {
        pass.failed++;
        break;
      }
      pass.read++;
      if (answer.status !== 200) {
        pass.stopped = `${answer.status} sur products.json, lecture arrêtée`;
        break;
      }
      let products: CatalogProduct[];
      try {
        products = readShopifyProducts(JSON.parse(answer.body), source.origin);
      } catch {
        pass.failed++;
        break;
      }
      if (products.length === 0) break;
      for (const product of products) {
        const id = product.externalId as string;
        if (seen.has(id)) continue;
        seen.add(id);
        if (
          !wantedTitle(source, product.title) ||
          isKidsProduct(product.title, product.specs)
        ) {
          pass.skipped++;
          continue;
        }
        let row = known.get(id);
        if (!row) {
          const created = await this.offers.create({
            sourceId: source.id,
            externalId: id,
            url: product.url ?? source.origin,
            firstSeenAt: now.toISOString(),
          });
          row = { id: created.id, status: created.status };
          pass.discovered++;
        }
        await this.store(row, product, now, pass);
      }
    }
    // A variant the complete feed no longer lists is gone.
    if (!pass.stopped && pass.failed === 0) {
      for (const [id, row] of known) {
        if (!seen.has(id) && row.status === "active") {
          await this.offers.updateById(row.id, {
            status: "gone",
            availability: "out_of_stock",
          });
          pass.gone++;
        }
      }
    }
  }

  // -------------------------------------------------------------- probe

  /**
   * The test before a source is switched on: can its list be read, and do
   * five of its pages give a product with a price? Reads at most
   * ~10 pages, writes nothing.
   */
  async probe(sourceId: string): Promise<CatalogProbe> {
    const source = this.config().sources.find((s) => s.id === sourceId);
    const report: CatalogProbe = {
      sourceId,
      ok: false,
      robots: "absent",
      sitemapUrls: 0,
      wantedUrls: 0,
      samples: [],
    };
    if (!source) return { ...report, problem: "source inconnue ou invalide" };
    const robots = await this.robots(source);
    report.robots = robots ? "ok" : "absent";

    if (source.reader === "shopify") {
      if (!robotsAllows(robots, "/products.json")) {
        return { ...report, problem: "robots.txt interdit /products.json" };
      }
      const url = `${source.origin}/products.json?limit=250&page=1`;
      const answer = await this.fetchPage(url);
      let products: CatalogProduct[] = [];
      try {
        products = readShopifyProducts(JSON.parse(answer.body), source.origin);
      } catch {
        // Not JSON: reported below.
      }
      report.sitemapUrls = products.length;
      const kept = products.filter((p) => wantedTitle(source, p.title));
      report.wantedUrls = kept.length;
      report.samples = kept.slice(0, 5).map((p) => ({
        url: p.url ?? url,
        status: answer.status,
        product: true,
        title: p.title,
        price: p.price,
        ean: p.ean,
        reference: p.reference,
        kept: true,
      }));
      report.ok = kept.length >= 3;
      if (!report.ok) report.problem = `products.json : ${answer.status}`;
      return report;
    }

    const { all, wanted } = await this.sitemapUrls(source, robots);
    report.sitemapUrls = all;
    report.wantedUrls = wanted.length;
    if (wanted.length === 0) {
      return { ...report, problem: "aucune page produit dans le sitemap" };
    }
    const step = Math.max(1, Math.floor(wanted.length / 5));
    const picks = [0, 1, 2, 3, 4]
      .map((i) => wanted[i * step])
      .filter((url): url is string => !!url);
    for (const url of picks) {
      await this.sleep(pauseMsOf(source));
      if (!robotsAllows(robots, new URL(url).pathname)) {
        report.samples.push({ url, status: 0, product: false });
        continue;
      }
      try {
        const answer = await this.fetchPage(url);
        const product =
          answer.status === 200 ? readProductPage(answer.body) : undefined;
        report.samples.push({
          url,
          status: answer.status,
          product: !!product,
          title: product?.title,
          price: product?.price,
          ean: product?.ean,
          reference: product?.reference,
          kept: product ? wantedTitle(source, product.title) : undefined,
        });
      } catch {
        report.samples.push({ url, status: 0, product: false });
      }
    }
    const good = report.samples.filter(
      (sample) => sample.product && sample.price !== undefined,
    ).length;
    report.ok = good >= 3;
    if (!report.ok) {
      report.problem = `${good} page(s) sur ${report.samples.length} avec un produit et un prix`;
    }
    return report;
  }

  /** Per source: its settings and what is stored. */
  async status() {
    const config = this.config();
    const rows = await this.offers.findMany({});
    return {
      activeHours: config.activeHours ?? DEFAULT_ACTIVE_HOURS,
      running: [...this.running],
      sources: config.sources.map((source) => {
        const mine = rows.filter((row) => row.sourceId === source.id);
        const count = (status: string) =>
          mine.filter((row) => row.status === status).length;
        const lastReadAt = mine
          .map((row) => row.lastReadAt)
          .filter((value): value is string => !!value)
          .sort()
          .at(-1);
        return {
          id: source.id,
          name: source.name,
          reader: source.reader,
          verified: !!source.verified,
          enabled: !!source.enabled,
          perRun: perRunOf(source),
          pending: count("pending"),
          active: count("active"),
          skipped: count("skipped"),
          gone: count("gone"),
          withEan: mine.filter((row) => row.status === "active" && row.ean)
            .length,
          lastReadAt,
        };
      }),
    };
  }
}
