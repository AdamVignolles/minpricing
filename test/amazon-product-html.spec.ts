import { describe, expect, test } from "vitest";

import {
  isAmazonChallenge,
  parseAmazonProductHtml,
} from "../src/api/collectors/amazonProductHtml.ts";

const PAGE = `<html><head><style>.x{color:red}</style></head><body>
<span id="productTitle"> Aspirateur robot Foo </span>
<div id="wayfinding-breadcrumbs_feature_div"><ul><li><a> Cuisine et Maison </a></li></ul></div>
<img id="landingImage" src="https://m.media-amazon.com/images/I/a.jpg" data-old-hires="https://m.media-amazon.com/images/I/big.jpg">
<div id="corePriceDisplay_desktop_feature_div">
  <span class="priceToPay"><span class="a-offscreen">17,75 €</span></span>
  <span class="basisPrice"><span class="a-offscreen">29,99 €</span></span>
  <span class="aok-hidden">Prix caché 1 €</span>
</div>
<span id="acrPopover" title="4,4 sur 5 étoiles"></span>
<span id="acrCustomerReviewText">1 234 évaluations</span>
<div id="feature-bullets"><ul class="a-unordered-list">
  <li><span class="a-list-item">Aspire fort et longtemps</span></li>
  <li class="aok-hidden"><span class="a-list-item">Filler caché</span></li>
</ul></div>
</body></html>`;

describe("parseAmazonProductHtml", () => {
  test("reads price, struck price, title, breadcrumb, image and bullets", () => {
    const read = parseAmazonProductHtml(PAGE);
    expect(read?.price).toBe(17.75);
    expect(read?.listPrice).toBe(29.99);
    expect(read?.title).toBe("Aspirateur robot Foo");
    expect(read?.breadcrumb).toBe("Cuisine et Maison");
    expect(read?.imageUrl).toBe("https://m.media-amazon.com/images/I/big.jpg");
    expect(read?.description).toBe("- Aspire fort et longtemps");
  });

  test("ignores a struck price that is not above the price", () => {
    const read = parseAmazonProductHtml(PAGE.replace("29,99 €", "10,00 €"));
    expect(read?.listPrice).toBeUndefined();
  });

  test("a page without a price gives nothing, so the browser takes over", () => {
    expect(
      parseAmazonProductHtml(PAGE.replace(/priceToPay/g, "other")),
    ).toBeUndefined();
  });

  test("detects Amazon's robot check", () => {
    const challenge =
      '<form action="/errors/validateCaptcha">Saisissez les caractères</form>';
    expect(isAmazonChallenge(challenge)).toBe(true);
    expect(parseAmazonProductHtml(challenge)).toBeUndefined();
    expect(isAmazonChallenge(PAGE)).toBe(false);
  });
});
