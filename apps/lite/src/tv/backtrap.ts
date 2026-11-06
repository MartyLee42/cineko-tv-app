// The remote's Back on TV hosts (Media Station X on Android/Tizen, webOS):
// the host runs its own Back too — WebView goBack(), history.back(), or
// closing the window when the page has no history. The TV build keeps its
// navigation in memory, so a same-document history entry absorbs the
// native Back: it arrives as `popstate`, the entry is put back and the press
// becomes one in-app Back — unless the keydown of the same press was already
// handled. (Same approach as the full app's apps/tv/src/remote/backTrap.ts.)

const DEDUPE_MS = 700;
let trap: { baseLength: number; leaving: boolean } | null = null;

function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === "GoBack" || e.key === "BrowserBack" || e.key === "Escape" || e.key === "Backspace") return true;
  return e.keyCode === 8 || e.keyCode === 27 || e.keyCode === 461 || e.keyCode === 10009 || e.keyCode === 166;
}

export function installBackTrap(onBack: () => void): void {
  if (trap || typeof history === "undefined") return;
  const t = { baseLength: history.length, leaving: false };
  try {
    history.pushState({ cineko: "back-trap" }, "");
  } catch {
    return;
  }
  trap = t;
  let lastKeyAt = -Infinity;
  window.addEventListener(
    "keydown",
    (e) => {
      if (isBackKey(e)) lastKeyAt = Date.now();
    },
    true,
  );
  window.addEventListener("popstate", () => {
    if (t.leaving) return;
    try {
      history.pushState({ cineko: "back-trap" }, "");
    } catch {
      /* keep going */
    }
    if (Date.now() - lastKeyAt <= DEDUPE_MS) return; // the keydown already did it
    onBack();
  });
}

/** Leaves the app on purpose (Back on Home twice): back to whatever opened it. */
export function exitApp(): void {
  if (trap) {
    trap.leaving = true;
    if (trap.baseLength > 1) history.go(-2);
    else history.back();
  }
  try {
    window.close();
  } catch {
    /* ignore */
  }
}
