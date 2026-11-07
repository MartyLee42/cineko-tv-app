import { describe, expect, it } from "vitest";
import { remoteTrackLabel } from "./releases";

describe("phone remote: track names", () => {
  it("shows the TV's own label (language + studio) as is", () => {
    expect(remoteTrackLabel({ label: "Русский · LF", language: "ru" }, "ru")).toBe("Русский · LF");
    expect(remoteTrackLabel({ label: "Русский · TVS", language: "ru" }, "ru")).toBe("Русский · TVS");
  });

  it("names a bare or missing label from the language", () => {
    expect(remoteTrackLabel({ label: "ru", language: "ru" }, "ru")).not.toBe("ru");
    expect(remoteTrackLabel({ label: "", language: "en" }, "en")).toBe("English");
  });
});
