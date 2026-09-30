import { Alepha } from "alepha";
import { expect, test } from "vitest";

test("alepha app can be created", () => {
  const alepha = Alepha.create();

  expect(alepha).toBeDefined();
  expect(alepha.inject).toBeTypeOf("function");
});
