import type { QRCodeToDataURLOptions } from "qrcode";

// The QR encoder (~20 KB) loads on demand: a paired TV starting at Home never
// needs it. Call qrLoad() early (before awaiting the API) to fetch it in parallel.
let mod: Promise<typeof import("qrcode")> | null = null;

export function qrLoad() {
  mod ??= import("qrcode").catch((e: unknown) => {
    mod = null;
    throw e;
  });
  return mod;
}

/** A data: URL with the QR code of `text`. */
export function qrDataUrl(text: string, opts: QRCodeToDataURLOptions): Promise<string> {
  // A CommonJS module: the bundler hands its exports over as `default` (and as named exports).
  return qrLoad().then((m) => ((m as unknown as { default?: typeof m }).default ?? m).toDataURL(text, opts));
}
