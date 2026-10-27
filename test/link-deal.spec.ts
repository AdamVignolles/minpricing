import { Alepha } from "alepha";
import { afterEach, expect, test, vi } from "vitest";

import { ApiModule } from "../src/api/index.ts";
import { LinkDealService } from "../src/api/services/LinkDealService.ts";

const STEAM = {
  "620": {
    success: true,
    data: {
      name: "Portal 2",
      header_image: "https://img/portal.jpg",
      price_overview: { initial: 1999, final: 499 },
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

test("preview writes nothing, save creates then dedupes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(STEAM))),
  );
  const alepha = Alepha.create({
    env: { ADMIN_USERNAME: "a", ADMIN_PASSWORD: "a" },
  }).with(ApiModule);
  await alepha.start();
  const service = alepha.inject(LinkDealService);
  const deals = (service as unknown as { deals: { count(): Promise<number> } })
    .deals;
  const url = "https://store.steampowered.com/app/620/Portal_2/";

  const preview = await service.preview(url);
  expect(preview).toMatchObject({ sourceId: "steam", price: 4.99 });
  expect(await deals.count()).toBe(0);

  const first = await service.save(url);
  expect(first.result).toBe("created");
  const second = await service.save(url);
  expect(second.result).toBe("updated");
  expect(await deals.count()).toBe(1);

  await alepha.stop();
});
