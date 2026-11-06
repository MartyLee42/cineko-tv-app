// «Предлагать раздачу полегче» (this browser; off by default): the player's
// «Скорость соединения ниже, чем нужно… Выбрать раздачу полегче?» hint.
const KEY = "martytv.slow_hint";

export const slowHintPref = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  },
  set(on: boolean) {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* private mode: stays off */
    }
  },
};
