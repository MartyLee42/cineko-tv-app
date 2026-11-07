// A design's extra line under failure messages (errors, playback that failed). Only «Одиссея» has
// one: the ship computer's calm «Я не могу это сделать, Дейв.»
import type { DesignSetting, MessageKey } from "@martytv/ui";

export function failHintKey(design: DesignSetting | null): MessageKey | null {
  return design === "odyssey" ? "designs.odyssey.cant" : null;
}
