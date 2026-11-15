import { describe, expect, it } from "vitest";
import { lockScroll, type ScrollDoc, type ScrollWin } from "./scrollLock";

const style = () => ({ overflow: "", overscrollBehavior: "", position: "", top: "", left: "", right: "", width: "" });

describe("lockScroll", () => {
  it("pins the page where it was while any modal is open and puts it back after the last one", () => {
    const doc: ScrollDoc = { documentElement: { style: { overflow: "" } }, body: { style: { ...style(), overflow: "auto" } } };
    const scrolls: ScrollToOptions[] = [];
    const win: ScrollWin = { scrollX: 0, scrollY: 1840, scrollTo: (o) => scrolls.push(o) };
    const a = lockScroll(doc, win);
    const b = lockScroll(doc, win);
    // Pinned at the current offset: nothing moves on screen.
    expect(doc.body.style.position).toBe("fixed");
    expect(doc.body.style.top).toBe("-1840px");
    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.documentElement.style.overflow).toBe("hidden");
    a();
    a();
    expect(doc.body.style.position).toBe("fixed");
    expect(scrolls).toEqual([]);
    b();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.body.style.position).toBe("");
    expect(doc.body.style.top).toBe("");
    expect(doc.documentElement.style.overflow).toBe("");
    expect(scrolls).toEqual([{ left: 0, top: 1840, behavior: "instant" }]);
  });
});
