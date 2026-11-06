import { describe, expect, it } from "vitest";
import { en as coreEn } from "./locales/en";
import { ru as coreRu } from "./locales/ru";
import { catalogEn } from "./locales/catalog.en";
import { catalogRu } from "./locales/catalog.ru";
import { remoteEn } from "./locales/remote.en";
import { remoteRu } from "./locales/remote.ru";
import { playerEn } from "./locales/player.en";
import { playerRu } from "./locales/player.ru";
import { settingsEn } from "./locales/settings.en";
import { settingsRu } from "./locales/settings.ru";
import { tvdesignEn } from "./locales/tvdesign.en";
import { tvdesignRu } from "./locales/tvdesign.ru";
import { errorsEn } from "./locales/errors.en";
import { errorsRu } from "./locales/errors.ru";
import { adminEn } from "./locales/admin.en";
import { adminRu } from "./locales/admin.ru";
import { sourcesEn } from "./locales/sources.en";
import { sourcesRu } from "./locales/sources.ru";
import { importsEn } from "./locales/imports.en";
import { importsRu } from "./locales/imports.ru";
import { onlineEn } from "./locales/online.en";
import { onlineRu } from "./locales/online.ru";
import { foryouEn } from "./locales/foryou.en";
import { foryouRu } from "./locales/foryou.ru";
import { askEn } from "./locales/ask.en";
import { askRu } from "./locales/ask.ru";
import { tasteEn } from "./locales/taste.en";
import { tasteRu } from "./locales/taste.ru";
import { downloadsEn } from "./locales/downloads.en";
import { downloadsRu } from "./locales/downloads.ru";
import { iptvEn } from "./locales/iptv.en";
import { iptvRu } from "./locales/iptv.ru";
import { videoEn } from "./locales/video.en";
import { videoRu } from "./locales/video.ru";
import { seasonsEn } from "./locales/seasons.en";
import { seasonsRu } from "./locales/seasons.ru";
import { designsEn } from "./locales/designs.en";
import { designsRu } from "./locales/designs.ru";
import { tvplayEn } from "./locales/tvplay.en";
import { tvplayRu } from "./locales/tvplay.ru";
import { playerStatsEn } from "./locales/playerstats.en";
import { playerStatsRu } from "./locales/playerstats.ru";
import { devprefsEn } from "./locales/devprefs.en";
import { devprefsRu } from "./locales/devprefs.ru";
import { superplayEn } from "./locales/superplay.en";
import { superplayRu } from "./locales/superplay.ru";
import { healthEn } from "./locales/health.en";
import { healthRu } from "./locales/health.ru";

const en: Record<string, string> = { ...coreEn, ...catalogEn, ...remoteEn, ...playerEn, ...settingsEn, ...adminEn, ...tvdesignEn, ...errorsEn, ...sourcesEn, ...importsEn, ...onlineEn, ...foryouEn, ...askEn, ...tasteEn, ...downloadsEn, ...iptvEn, ...designsEn, ...videoEn, ...seasonsEn, ...tvplayEn, ...playerStatsEn, ...devprefsEn, ...superplayEn, ...healthEn };
const ru: Record<string, string> = { ...coreRu, ...catalogRu, ...remoteRu, ...playerRu, ...settingsRu, ...adminRu, ...tvdesignRu, ...errorsRu, ...sourcesRu, ...importsRu, ...onlineRu, ...foryouRu, ...askRu, ...tasteRu, ...downloadsRu, ...iptvRu, ...designsRu, ...videoRu, ...seasonsRu, ...tvplayRu, ...playerStatsRu, ...devprefsRu, ...superplayRu, ...healthRu };
import { format, translate } from "./i18n";

describe("translations", () => {
  it("ru has exactly the en keys", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps the same placeholders in every language", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en)) {
      expect(vars(ru[key]!), key).toEqual(vars(en[key]!));
    }
  });

  it("formats placeholders", () => {
    expect(format("Hi, {name}", { name: "Cineko" })).toBe("Hi, Cineko");
    expect(format("{missing}", {})).toBe("{missing}");
    expect(translate("ru", "home.welcome", { name: "Cineko" })).toBe("Привет, Cineko");
  });
});
