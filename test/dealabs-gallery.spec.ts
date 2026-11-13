import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  DealabsPublisherService,
  hasProductImage,
} from "../src/api/services/DealabsPublisherService.ts";

type Browser = import("playwright").Browser;

/** Reads the gallery as the publisher does (no app needed). */
class Reader extends DealabsPublisherService {
  read(page: import("playwright").Page) {
    return this.formImages(page);
  }
}
const reader = Object.create(Reader.prototype) as Reader;

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("product picture in Dealabs' gallery step (13/11)", () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  });
  afterAll(() => browser?.close());

  test("a gallery tile drawn as a background, outside the first <form>", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <header><img src="${pixel}" width="80" height="80" alt="Mon profil"></header>
      <form role="search"><input name="q"></form>
      <section><div style="width:150px;height:150px;background-image:url('${pixel}')"></div></section>`);
    expect(hasProductImage(await reader.read(page))).toBe(true);
    await page.close();
  });

  test("an <img> preview counts too", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<form><input name="q"></form><div><img src="${pixel}" width="200" height="150"></div>`,
    );
    expect(hasProductImage(await reader.read(page))).toBe(true);
    await page.close();
  });

  test("the header's avatar alone is no product picture", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<header><img src="${pixel}" width="80" height="80"></header><nav><div style="width:90px;height:90px;background-image:url('${pixel}')"></div></nav><main>Galerie vide</main>`,
    );
    expect(hasProductImage(await reader.read(page))).toBe(false);
    await page.close();
  });
});
