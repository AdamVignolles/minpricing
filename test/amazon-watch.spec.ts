import { describe, expect, test } from "vitest";

import {
  parseBestSellers,
  silentDrop,
} from "../src/api/services/amazonWatch.ts";

const now = new Date("2026-10-21T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 86_400_000).toISOString();

describe("silentDrop", () => {
  test("watched for less than 3 days: no verdict", () => {
    expect(
      silentDrop([{ price: 99.99, observedAt: daysAgo(1) }], 59.99, now),
    ).toBe(undefined);
  });

  test("a clear drop under the usual price and the month's low", () => {
    const drop = silentDrop(
      [
        { price: 99.99, observedAt: daysAgo(12) },
        { price: 94.99, observedAt: daysAgo(6) },
        { price: 99.99, observedAt: daysAgo(4) },
      ],
      79.99,
      now,
    );
    expect(drop).toMatchObject({ usualPrice: 99.99, monthLow: 94.99 });
    expect(drop?.days).toBeGreaterThanOrEqual(10);
  });

  test("its normal back-and-forth is not a drop", () => {
    // Usually 99,99 €, regularly at 79,99 €: 79,99 € today isn't news.
    const history = [
      { price: 99.99, observedAt: daysAgo(20) },
      { price: 79.99, observedAt: daysAgo(15) },
      { price: 99.99, observedAt: daysAgo(12) },
      { price: 74.99, observedAt: daysAgo(8) },
      { price: 99.99, observedAt: daysAgo(5) },
    ];
    expect(silentDrop(history, 79.99, now)).toBe(undefined);
  });

  test("a 9 999 € placeholder replaced by a real offer isn't a drop", () => {
    expect(
      silentDrop([{ price: 9999, observedAt: daysAgo(10) }], 2499, now),
    ).toBe(undefined);
  });

  test("too small to matter: under 15 % or 5 €", () => {
    const history = [{ price: 29.99, observedAt: daysAgo(10) }];
    expect(silentDrop(history, 26.99, now)).toBe(undefined);
    expect(
      silentDrop([{ price: 19.99, observedAt: daysAgo(10) }], 15.99, now),
    ).toBe(undefined);
  });
});

describe("parseBestSellers", () => {
  test("reads a best-seller card", () => {
    const html = `<div id="gridItemRoot"><div data-asin="B00NTCH52W">
      <span class="zg-bdg-text">#2</span>
      <img alt="Amazon Basics Lot de 20 piles AA" src="https://images-eu.ssl-images-amazon.com/x.jpg">
      <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Amazon Basics Lot de 20 piles alcalines AA</div>
      <i class="a-icon"><span>4,6 sur 5 étoiles</span></i><span class="a-size-small">937 080</span>
      <span class="_cDEzb_p13n-sc-price_3mJ9Z">8,79 €</span></div></div>`;
    expect(parseBestSellers(html)).toEqual([
      {
        asin: "B00NTCH52W",
        title: "Amazon Basics Lot de 20 piles alcalines AA",
        price: 8.79,
        url: "https://www.amazon.fr/dp/B00NTCH52W",
        imageUrl: "https://images-eu.ssl-images-amazon.com/x.jpg",
        rating: 4.6,
        reviewCount: 937080,
      },
    ]);
  });
});
