import { describe, expect, test } from "vitest";

import {
  failureReason,
  formatAmazonFailures,
} from "../src/api/collectors/AmazonCollector.ts";
import { withDeadline } from "../src/api/collectors/browser.ts";

describe("Amazon run note: why pages gave nothing", () => {
  test("names the usual failures in French", () => {
    expect(
      failureReason(new Error("page.goto: Page crashed\nCall log: …")),
    ).toBe("page plantée");
    expect(failureReason(new Error("Timeout 20000ms exceeded."))).toBe(
      "délai dépassé",
    );
    expect(failureReason(new Error("Amazon deals page returned 503"))).toBe(
      "réponse 503",
    );
  });

  test("one line with the counts, most frequent reason first", () => {
    const failures = new Map([
      ["fiche : prix introuvable", 1],
      ["fiche : page plantée", 11],
      ["liste : délai dépassé", 2],
    ]);
    expect(
      formatAmazonFailures({
        listings: 15,
        emptyListings: 3,
        candidates: 13,
        failures,
      }),
    ).toBe(
      "Amazon : 15 liste(s) (3 vide(s)), 12 fiche(s) sans résultat sur 13 — fiche : page plantée ×11, liste : délai dépassé ×2, fiche : prix introuvable ×1",
    );
  });
});

describe("withDeadline", () => {
  test("a call that never answers is given up, as a timeout", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 20, "fiche produit")).rejects.toThrow(
      /Timeout: fiche produit/,
    );
    expect(
      failureReason(new Error("Timeout: fiche produit sans réponse")),
    ).toBe("délai dépassé");
  });

  test("an answer in time goes through", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });
});
