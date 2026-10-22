import { describe, expect, test } from "vitest";

import {
  nintendoGameName,
  parseDekuHistory,
  pickDekuItem,
  seriesChartConfig,
  seriesLow,
} from "../src/api/services/priceSeries.ts";

const history = (rows: unknown[]) =>
  `<script id='price_history_data' type='application/json'>${JSON.stringify({
    headers: ["Nintendo eShop (Switch)", "Nintendo eShop (Switch 2)"],
    data: rows,
  })}</script>`;

describe("DekuDeals", () => {
  test("picks the game itself, not a DLC or bundle", () => {
    const html = `
      <a href='/items/hogwarts-legacy-dark-arts-pack'><strong>Hogwarts Legacy: Dark Arts Pack</strong></a>
      <a href='/items/hogwarts-legacy'><strong>Hogwarts Legacy</strong></a>`;
    expect(
      pickDekuItem(
        html,
        "Hogwarts Legacy : L'Héritage de Poudlard (Nintendo Switch, eShop)",
      ),
    ).toBe("hogwarts-legacy");
    expect(pickDekuItem(html, "Zelda (Nintendo Switch, eShop)")).toBe(
      undefined,
    );
  });

  test("keeps the console's column and only price changes", () => {
    const html = history([
      ["2025-01-01", null, 59.99, null],
      ["2025-01-02", null, 59.99, null],
      ["2025-03-01", null, 29.99, 69.99],
      ["2025-04-01", null, 59.99, 39.99],
    ]);
    expect(parseDekuHistory(html, false)).toEqual([
      ["2025-01-01", 59.99],
      ["2025-03-01", 29.99],
      ["2025-04-01", 59.99],
    ]);
    expect(parseDekuHistory(html, true)).toEqual([
      ["2025-03-01", 69.99],
      ["2025-04-01", 39.99],
    ]);
  });

  test("low since a date; game name without our suffix", () => {
    const points: Array<[string, number]> = [
      ["2019-01-01", 4.99],
      ["2025-03-01", 29.99],
      ["2025-06-01", 19.99],
    ];
    expect(seriesLow(points, "2024-10-01")).toEqual({
      price: 19.99,
      at: "2025-06-01",
    });
    expect(
      nintendoGameName("Street Fighter 6 (Nintendo Switch 2, eShop)"),
    ).toBe("Street Fighter 6");
  });

  test("chart config covers the last year up to today", () => {
    const config = seriesChartConfig(
      {
        source: "Nintendo eShop, via DekuDeals",
        url: "https://www.dekudeals.com/items/x",
        points: [
          ["2024-01-01", 59.99],
          ["2026-03-01", 29.99],
        ],
      },
      "Jeu",
      "2026-10-15",
    ) as { data: { labels: string[]; datasets: Array<{ data: number[] }> } };
    expect(config.data.labels[0]).toBe("2025-10-15");
    expect(config.data.labels.at(-1)).toBe("2026-10-15");
    const prices = config.data.datasets[0].data;
    expect(prices[0]).toBe(59.99);
    expect(prices.at(-1)).toBe(29.99);
    // Weekly samples over a year, plus today.
    expect(config.data.labels.length).toBeGreaterThanOrEqual(53);
  });
});
