import { describe, expect, it } from "vitest";
import { messagesRu } from "../../../../../packages/ui/src/locales/all.ru";
import { PROJECTOR_ICONS, PROJECTOR_TEXT } from "../menuOrder";
import { chapterOf } from "./andersonChapter";

describe("«Симметрия» chapter cards", () => {
  it("numbers the chapters in the menu's order, Home first", () => {
    expect(chapterOf("home")).toEqual({ n: 1, nameKey: "nav.home" });
    expect(chapterOf("movies")?.n).toBe(PROJECTOR_TEXT.indexOf("movies") + 1);
    expect(chapterOf("search")?.n).toBe(PROJECTOR_TEXT.length + PROJECTOR_ICONS.indexOf("search") + 1);
  });

  it("every menu tab has a chapter named by an existing string; other screens have none", () => {
    const all = [...PROJECTOR_TEXT, ...PROJECTOR_ICONS];
    expect(new Set(all.map((id) => chapterOf(id)?.n)).size).toBe(all.length);
    for (const id of all) expect(messagesRu[chapterOf(id)!.nameKey], id).toBeTruthy();
    expect(chapterOf("profile")).toBeNull();
    expect(chapterOf(null)).toBeNull();
  });
});
