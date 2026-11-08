import { describe, expect, it } from "vitest";
import { lockScroll } from "./scrollLock";

describe("lockScroll", () => {
  it("locks the page while any modal is open and restores it after the last one", () => {
    const doc = { documentElement: { style: { overflow: "" } }, body: { style: { overflow: "auto", overscrollBehavior: "" } } };
    const a = lockScroll(doc);
    const b = lockScroll(doc);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.documentElement.style.overflow).toBe("hidden");
    a();
    a();
    expect(doc.body.style.overflow).toBe("hidden");
    b();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overflow).toBe("");
  });
});
