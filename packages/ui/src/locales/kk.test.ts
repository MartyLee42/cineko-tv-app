import { describe, expect, it } from "vitest";
import { messagesRu } from "./all.ru";
import { messagesKk } from "./all.kk";
import { detectLocale } from "../localeDetect";

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Kazakh strings", () => {
  it("has every Russian key", () => {
    expect(Object.keys(messagesKk).sort()).toEqual(Object.keys(messagesRu).sort());
  });

  it("keeps each string's placeholders and fills it in", () => {
    const bad = Object.entries(messagesRu).filter(([k, ru]) => {
      const kk = (messagesKk as Record<string, string>)[k] ?? "";
      return kk.trim() === "" || holes(kk).join() !== holes(ru).join();
    });
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("is picked for a stored choice or a Kazakh browser", () => {
    expect(detectLocale("kk")).toBe("kk");
  });
});
