import { $env, z } from "alepha";
import { $cache } from "alepha/cache";
import { $logger } from "alepha/logger";

import { type DealabsThread, parseDealabsSearch } from "./dealabsSearch.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};
const MAX_PAGES = 5;

/**
 * Our own Dealabs posts, read from our public profile (30 per page) and
 * cached an hour. The product searches used for a deal's history miss a
 * post whose Dealabs title differs from the merchant's; the profile lists
 * every post, so "Publié par vous" doesn't depend on that search.
 */
export class MyDealabsPostsService {
  protected log = $logger();
  protected env = $env(z.object({ DEALABS_USERNAME: z.string().default("") }));
  protected cache = $cache<DealabsThread[]>({
    name: "my-dealabs-posts",
    ttl: [1, "hours"],
  });

  /** Last list read, served while a fresh one is being fetched. */
  protected last: DealabsThread[] = [];
  protected refreshing?: Promise<DealabsThread[]>;

  /**
   * Our posts, never waiting on Dealabs: the cached list, or the last one
   * while the profile is read again in the background (5 paced pages
   * would otherwise hold a deals list for ~8 s once an hour).
   */
  async posts(): Promise<DealabsThread[]> {
    const user = this.env.DEALABS_USERNAME;
    if (!user) return [];
    const cached = await this.cache.get(user).catch(() => undefined);
    if (cached) {
      this.last = cached;
      return cached;
    }
    this.refreshing ??= this.fetchPosts(user).finally(() => {
      this.refreshing = undefined;
    });
    return this.last;
  }

  /**
   * Our posts, waiting for the profile read when nothing is cached yet —
   * for callers that need the real list (the agents' report), not a
   * page that must render immediately.
   */
  async postsNow(): Promise<DealabsThread[]> {
    const posts = await this.posts();
    if (posts.length > 0 || !this.refreshing) return posts;
    return this.refreshing;
  }

  protected async fetchPosts(user: string): Promise<DealabsThread[]> {
    const posts: DealabsThread[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const response = await fetch(
          `https://www.dealabs.com/profile/${encodeURIComponent(user)}/bons-plans?page=${page}`,
          { headers: HEADERS, signal: AbortSignal.timeout(15_000) },
        );
        if (!response.ok) break;
        const found = parseDealabsSearch(await response.text()).filter(
          (thread) => !posts.some((post) => post.id === thread.id),
        );
        if (found.length === 0) break;
        posts.push(...found);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      } catch (error) {
        this.log.warn("Dealabs profile unreadable", {
          page,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    await this.cache.set(user, posts).catch(() => undefined);
    this.last = posts;
    return posts;
  }
}
