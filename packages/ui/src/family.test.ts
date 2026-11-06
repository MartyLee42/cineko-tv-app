import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "./i18n";
import { calendarDaysAgo, endorsementText, familyWhyText, likedByText, matchText, membersWithMatch, daysPluralForm, type FamilyEndorsementLike, type FamilyMemberLike } from "./family";
import { reasonText, rowTitle } from "./foryou";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const now = new Date(2026, 10, 1, 20, 0, 0);
const at = (daysBack: number, hour = 12) => new Date(2026, 10, 1 - daysBack, hour).toISOString();

const person = (p: Partial<FamilyEndorsementLike>): FamilyEndorsementLike => ({
  profile_id: "p",
  name: "Анна",
  avatar: "",
  color: "#ff0000",
  rating: null,
  completed: false,
  completed_at: null,
  favorite: false,
  liked: true,
  ...p,
});

describe("family helpers", () => {
  it("counts calendar days and plural forms", () => {
    expect(calendarDaysAgo(at(0, 1), now)).toBe(0);
    expect(calendarDaysAgo(at(1, 23), now)).toBe(1);
    expect(calendarDaysAgo("garbage", now)).toBe(0);
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(daysPluralForm)).toEqual(["one", "few", "many", "many", "many", "one", "few", "many"]);
  });

  it("describes one member", () => {
    expect(endorsementText(person({ rating: 9, completed: true, completed_at: at(1) }), ru, now)).toBe("Анна ★9");
    expect(endorsementText(person({ name: "Олег", completed: true, completed_at: at(1) }), ru, now)).toBe("Олег: посмотрено вчера");
    expect(endorsementText(person({ name: "Олег", completed: true, completed_at: at(0) }), en, now)).toBe("Олег watched it today");
    expect(endorsementText(person({ completed: true, completed_at: at(3) }), ru, now)).toBe("Анна: посмотрено 3 дня назад");
    expect(endorsementText(person({ completed: true, completed_at: at(5) }), ru, now)).toBe("Анна: посмотрено 5 дней назад");
    expect(endorsementText(person({ completed: true, completed_at: at(21) }), ru, now)).toBe("Анна: посмотрено 21 день назад");
    expect(endorsementText(person({ completed: true, completed_at: at(90) }), ru, now)).toBe("Анна: посмотрено");
    expect(endorsementText(person({ favorite: true }), ru, now)).toBe("Анна ♥");
  });

  it("builds the why line and «Понравилось двоим»", () => {
    const why = {
      people: [person({ rating: 9 }), person({ name: "Олег", completed: true, completed_at: at(1) }), person({ name: "Ира", favorite: true })],
      liked_by: 3,
      text: "server",
    };
    expect(familyWhyText(why, ru, now)).toBe("Анна ★9 · Олег: посмотрено вчера +1");
    expect(familyWhyText(why, ru, now, 3)).toBe("Анна ★9 · Олег: посмотрено вчера · Ира ♥");
    expect(familyWhyText({ people: [], liked_by: 0, text: "server" }, ru, now)).toBe("server");
    expect(likedByText(1, ru)).toBeNull();
    expect(likedByText(2, ru)).toBe("Понравилось двоим");
    expect(likedByText(3, ru)).toBe("Понравилось троим");
    expect(likedByText(7, ru)).toBe("Понравилось 7 членам семьи");
    expect(likedByText(2, en)).toBe("Two of you liked it");
  });

  it("shows taste match", () => {
    const m = (name: string, match: number | null): FamilyMemberLike => ({ profile_id: name, name, avatar: "", color: "#000000", match, co_rated: 3 });
    expect(matchText(m("Анна", 82), ru)).toBe("Анна: совпадение вкусов 82 %");
    expect(matchText(m("Олег", null), ru)).toBeNull();
    expect(membersWithMatch([m("a", 40), m("b", null), m("c", 90)]).map((x) => x.name)).toEqual(["c", "a"]);
  });

  it("plugs into «Для вас» reasons and row titles", () => {
    const r = { type: "family", text: "server", media_title: null, person_name: null, genre_names: [], collection_title: null, mood: null };
    expect(reasonText({ ...r, family: { people: [person({ rating: 10 })], liked_by: 1, text: "x" } }, ru)).toBe("Анна ★10");
    expect(reasonText(r, ru)).toBe("server");
    expect(rowTitle({ kind: "family", title: "srv", reason: r }, ru)).toBe("Семья советует");
    expect(rowTitle({ kind: "family", title: "srv", reason: r }, en)).toBe("Family picks");
  });
});
