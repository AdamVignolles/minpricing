import { z } from "alepha";
import { $route } from "alepha/server";

import { $adminSession } from "../services/AdminAuth.ts";
import { keepaChartUrl } from "../services/keepa.ts";

const RANGES = ["30", "90", "180", "365"] as const;
const SIZES = { small: [800, 300], large: [1100, 450] } as const;
const TTL_MS = 60 * 60 * 1000;

/**
 * Keepa's price chart served from our own origin. Keepa answers 403 to an
 * image request that carries another site's referrer (any page embedding
 * it), so the console can't load it directly: the server fetches it
 * (no referrer) and passes it on, cached an hour per chart.
 */
export class KeepaController {
  protected cache = new Map<string, { at: number; png: Buffer }>();

  chart = $route({
    method: "GET",
    path: "/api/keepa/:asin",
    use: [$adminSession()],
    schema: {
      params: z.object({ asin: z.text() }),
      query: z.object({
        range: z.enum(RANGES).optional(),
        size: z.enum(["small", "large"]).optional(),
      }),
    },
    handler: async ({ params, query, reply }) => {
      const asin = params.asin.toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) {
        reply.status = 400;
        return "Invalid ASIN";
      }
      const range = query.range ?? "90";
      const [width, height] = SIZES[query.size ?? "small"];
      const key = `${asin}:${range}:${width}`;

      let entry = this.cache.get(key);
      if (!entry || Date.now() - entry.at > TTL_MS) {
        const url = new URL(keepaChartUrl(asin));
        url.searchParams.set("range", range);
        url.searchParams.set("width", String(width));
        url.searchParams.set("height", String(height));
        const response = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (DealRadar)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          reply.status = 502;
          return `Keepa answered ${response.status}`;
        }
        entry = {
          at: Date.now(),
          png: Buffer.from(await response.arrayBuffer()),
        };
        this.cache.set(key, entry);
      }

      reply.headers["content-type"] = "image/png";
      reply.headers["cache-control"] = "private, max-age=3600";
      return entry.png;
    },
  });
}
