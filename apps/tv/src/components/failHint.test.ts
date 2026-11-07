import { describe, expect, it } from "vitest";
import { DESIGNS } from "@martytv/ui";
import { designsEn } from "../../../../packages/ui/src/locales/designs.en";
import { designsKk } from "../../../../packages/ui/src/locales/designs.kk";
import { designsRu } from "../../../../packages/ui/src/locales/designs.ru";
import { failHintKey } from "./failHint";

describe("failHintKey", () => {
  it("only «Одиссея» adds the calm line, and it exists in every locale", () => {
    expect(DESIGNS.filter((d) => failHintKey(d) !== null)).toEqual(["odyssey"]);
    expect(failHintKey(null)).toBeNull();
    const key = failHintKey("odyssey") as keyof typeof designsEn;
    expect(designsRu[key]).toBe("Я не могу это сделать, Дейв.");
    expect(designsEn[key]).toBe("I'm afraid I can't do that.");
    expect(designsKk[key]).toContain("Дейв");
  });
});
