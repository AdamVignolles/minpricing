import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readSentPage } from "../src/api/services/pageRead.ts";
import { bookmarkletCode } from "../src/web/components/links/ReadButtonInstall.tsx";

const page = readFileSync(
  join(import.meta.dirname, "fixtures", "links", "amazon-B0DQVFFXN2.html"),
  "utf8",
);
const link = { sourceId: "amazon", externalId: "B0DQVFFXN2" };
const url = "https://www.amazon.fr/Some-Product/dp/B0DQVFFXN2?th=1";

describe("readSentPage (« Lire dans DealRadar », epic 33)", () => {
  test("the watched product's page: read with the collection's parser", () => {
    const read = readSentPage(link, url, page);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.raw).toMatchObject({
      externalId: "B0DQVFFXN2",
      url: "https://www.amazon.fr/dp/B0DQVFFXN2",
      merchantId: "amazon",
    });
    expect(read.raw.price).toBeGreaterThan(0);
  });

  test.each([
    [{ ...link, sourceId: "steam" }, url, page, /Amazon\.fr/],
    [link, "https://evil.example/dp/B0DQVFFXN2", page, /pas sur Amazon\.fr/],
    [link, "https://www.amazon.fr/dp/B0OTHER001", page, /produit suivi/],
    [
      link,
      url,
      '<form action="/errors/validateCaptcha">Saisissez les caractères que vous voyez</form>',
      /vérification anti-robot/,
    ],
    [link, url, "<html><body>vide</body></html>", /introuvable/],
  ])("refused: %#", (l, u, html, reason) => {
    const read = readSentPage(l, u, html);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toMatch(reason);
  });
});

describe("bookmarkletCode", () => {
  test("a javascript: link that parses and targets this DealRadar", () => {
    const code = bookmarkletCode("https://dealradar.example");
    expect(code.startsWith("javascript:")).toBe(true);
    const source = decodeURIComponent(code.slice("javascript:".length));
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain('"https://dealradar.example"');
    expect(source).toContain('"/lire"');
  });
});
