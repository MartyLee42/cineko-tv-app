// The viewer's AI creativity («Точнее / Обычно / Смелее»): a nudge on the
// admin's DeepSeek temperature (ForYouAskRequest.creativity). Remembered
// per device under `martytv.ai_creativity`.
export type AICreativity = "precise" | "normal" | "bold";

export const AI_CREATIVITY: AICreativity[] = ["precise", "normal", "bold"];

const KEY = "martytv.ai_creativity";

function store(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readAICreativity(): AICreativity {
  try {
    const v = store()?.getItem(KEY);
    return v === "precise" || v === "bold" ? v : "normal";
  } catch {
    return "normal";
  }
}

export function writeAICreativity(v: AICreativity): void {
  try {
    if (v === "normal") store()?.removeItem(KEY);
    else store()?.setItem(KEY, v);
  } catch {
    /* private mode: the choice lasts until reload */
  }
}
