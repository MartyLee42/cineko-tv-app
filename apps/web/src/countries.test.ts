import { describe, expect, it } from "vitest";
import { countryList, countryName } from "@martytv/media-types";

describe("countries", () => {
  it("names common countries in ru/en without Intl", () => {
    expect(countryName("US", "ru")).toBe("США");
    expect(countryName("gb", "en")).toBe("UK");
    expect(countryName("SU", "ru")).toBe("СССР");
  });
  it("lists up to 3 and marks the rest", () => {
    expect(countryList(["US", "GB"], "ru")).toBe("США, Великобритания");
    expect(countryList(["US", "GB", "FR", "DE"], "en")).toBe("USA, UK, France…");
    expect(countryList([], "ru")).toBeNull();
    expect(countryList(undefined, "ru")).toBeNull();
  });
  it("falls back to the code for unknown regions", () => {
    expect(countryName("ZZ", "ru").length).toBeGreaterThan(0);
  });
});
