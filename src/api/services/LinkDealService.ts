import { $inject, z } from "alepha";
import { $repository } from "alepha/orm";

import type { RawDeal } from "../collectors/DealSource.ts";
import { parseProductHtml } from "../collectors/genericProduct.ts";
import { dealEntity } from "../entities/Deal.ts";
import { CollectionService } from "./CollectionService.ts";
import {
  isShortLink,
  LinkError,
  parseLink,
  type ResolvedLink,
  resolveLink,
} from "./linkResolver.ts";
import { qualityIssue } from "./qualityGate.ts";

export type LinkPreview = {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  price: number;
  listPrice?: number;
  currency: string;
  imageUrl?: string;
  availability?: string;
  qualityIssue?: string;
  existingDealId?: string;
};

export const linkPreviewSchema = z.object({
  sourceId: z.text(),
  externalId: z.text(),
  url: z.text({ size: "rich" }),
  title: z.text({ size: "rich" }),
  price: z.number(),
  listPrice: z.number().optional(),
  currency: z.text(),
  imageUrl: z.text({ size: "rich" }).optional(),
  availability: z.text().optional(),
  qualityIssue: z.text({ size: "rich" }).optional(),
  existingDealId: z.text().optional(),
});

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Adds a deal from a pasted link. `preview` reads the page and writes
 * nothing; `save` stores it through the normal pipeline (score, draft,
 * history), optionally past the quality gate.
 */
export class LinkDealService {
  protected deals = $repository(dealEntity);
  protected collection = $inject(CollectionService);

  /** Follows redirects (short links) and re-checks the final host. */
  protected async expand(url: URL): Promise<URL> {
    if (!isShortLink(url.href)) return url;
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    return parseLink(response.url);
  }

  protected async fetchSteam(link: ResolvedLink): Promise<RawDeal> {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${link.externalId}&cc=fr&l=french`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const body = (await response.json()) as Record<
      string,
      {
        success: boolean;
        data?: {
          name?: string;
          is_free?: boolean;
          header_image?: string;
          short_description?: string;
          price_overview?: { initial: number; final: number };
        };
      }
    >;
    const app = body[link.externalId];
    if (!app?.success || !app.data?.name) {
      throw new LinkError("invalid-url", "Jeu introuvable sur Steam.");
    }
    const price = app.data.is_free
      ? 0
      : (app.data.price_overview?.final ?? NaN) / 100;
    if (!Number.isFinite(price)) {
      throw new LinkError("invalid-url", "Prix Steam indisponible.");
    }
    const initial = (app.data.price_overview?.initial ?? 0) / 100;
    return {
      externalId: link.externalId,
      title: app.data.name,
      url: link.canonicalUrl,
      imageUrl: app.data.header_image,
      price,
      listPrice: initial > price ? initial : undefined,
      currency: "EUR",
      availability: "in_stock",
      description: app.data.short_description,
    };
  }

  protected async fetchGeneric(link: ResolvedLink): Promise<RawDeal> {
    const response = await fetch(link.canonicalUrl, {
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "fr-FR,fr;q=0.9",
        accept: "text/html",
      },
      signal: AbortSignal.timeout(20_000),
    });
    // A redirect must not lead somewhere we would refuse to fetch.
    parseLink(response.url);
    if (!response.ok) {
      throw new LinkError(
        "invalid-url",
        `Le site a répondu ${response.status} : saisis le prix à la main.`,
      );
    }
    const product = parseProductHtml(await response.text());
    if (!product) {
      throw new LinkError(
        "invalid-url",
        "Prix introuvable sur la page : saisis le prix à la main.",
      );
    }
    return {
      externalId: link.externalId,
      title: product.title,
      url: link.canonicalUrl,
      imageUrl: product.imageUrl,
      price: product.price,
      listPrice: product.listPrice,
      currency: product.currency,
      availability: product.availability,
      description: product.description,
      details: product.details,
    };
  }

  protected async read(input: string): Promise<{
    link: ResolvedLink;
    raw: RawDeal;
  }> {
    const url = await this.expand(parseLink(input));
    const link = resolveLink(url.href);
    const raw =
      link.sourceId === "steam"
        ? await this.fetchSteam(link)
        : await this.fetchGeneric(link);
    return { link, raw };
  }

  public async preview(input: string): Promise<LinkPreview> {
    const { link, raw } = await this.read(input);
    const existing = await this.deals.findOne({
      where: {
        and: [
          { sourceId: { eq: link.sourceId } },
          { externalId: { eq: link.externalId } },
        ],
      },
    });
    return {
      sourceId: link.sourceId,
      externalId: link.externalId,
      url: raw.url,
      title: raw.title,
      price: raw.price,
      listPrice: raw.listPrice,
      currency: raw.currency,
      imageUrl: raw.imageUrl,
      availability: raw.availability,
      existingDealId: existing?.id,
      qualityIssue: qualityIssue({
        title: raw.title,
        sourceId: link.sourceId,
        productRating: raw.details?.productRating,
        productReviewCount: raw.details?.productReviewCount,
        price: raw.price,
        listPrice: raw.listPrice,
      }),
    };
  }

  public async save(input: string, options: { force?: boolean } = {}) {
    const { link, raw } = await this.read(input);
    return {
      sourceId: link.sourceId,
      ...(await this.collection.ingestSingle(link.sourceId, raw, {
        skipGate: options.force,
      })),
    };
  }
}
