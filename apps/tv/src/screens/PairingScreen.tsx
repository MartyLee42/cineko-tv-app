import { useEffect, useRef, useState } from "react";
import { qrDataUrl, qrLoad } from "./qr";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { Logo, Spinner, useI18n } from "@martytv/ui";
import { api } from "../api";
import { FocusButton } from "../focus";
import { defaultDeviceName, detectPlatform } from "../platform";
import { adoptServerNewTvDesign } from "../design/newTv";

type Start = Schemas["PairingStart"];

/**
 * Shows a QR code + short code, polls for approval, then exchanges the
 * request for this TV's credential. Restarts automatically on expiry/denial.
 */
export function PairingScreen({ onPaired, onManual, onDesign }: { onPaired: (credential: string) => void; onManual: () => void; onDesign?: () => void }) {
  const { t } = useI18n();
  const [req, setReq] = useState<Start | null>(null);
  const [qr, setQr] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string>("");
  const generation = useRef(0);

  // Start (or restart) a pairing request.
  const start = async (message = "") => {
    const gen = ++generation.current;
    setReq(null);
    setNote(message);
    // The QR encoder loads while the API answers.
    qrLoad().catch(() => undefined);
    try {
      const r = await unwrap(
        api.POST("/pairing", { body: { device_name: defaultDeviceName(), platform: detectPlatform() } }),
      );
      if (gen !== generation.current) return;
      // A TV with no design of its own yet wears the server's design for new TVs right away.
      if (adoptServerNewTvDesign(r.new_tv_design)) onDesign?.();
      setReq(r);
      setError("");
      setNote("");
      setQr(await qrDataUrl(r.verification_url_complete, { margin: 1, width: 360, errorCorrectionLevel: "M" }));
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof ApiError && e.code !== "network_error" ? e.message : t("tv.offline"));
      setTimeout(() => gen === generation.current && start(), 5000);
    }
  };

  useEffect(() => {
    const gen = generation;
    void start();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      gen.current++;
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the request's status with the secret only this TV knows.
  useEffect(() => {
    if (!req) return;
    const gen = generation.current;
    const headers = { Authorization: `Pairing ${req.poll_secret}` };
    let stopped = false;
    const poll = async () => {
      if (stopped || gen !== generation.current) return;
      try {
        const st = await unwrap(api.GET("/pairing/{id}", { params: { path: { id: req.pairing_id } }, headers }));
        if (stopped) return;
        if (st.status === "approved") {
          const res = await unwrap(
            api.POST("/pairing/{id}/exchange", { params: { path: { id: req.pairing_id } }, headers }),
          );
          onPaired(res.credential);
          return;
        }
        if (st.status === "denied") return void start(t("tv.pair.denied"));
        if (st.status === "expired" || st.status === "consumed") return void start(t("tv.pair.refreshing"));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return void start(t("tv.pair.refreshing"));
        // transient network error: keep polling
      }
      setTimeout(poll, (req.poll_interval_seconds || 2) * 1000);
    };
    const first = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const remaining = req ? Math.max(0, Math.floor((Date.parse(req.expires_at) - now) / 1000)) : 0;
  useEffect(() => {
    if (req && remaining === 0) void start(t("tv.pair.refreshing"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining === 0]);
  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    // Kept well inside the screen: some TVs crop their edges (overscan) or
    // report a viewport that doesn't match the panel; the code comes first.
    <div className="relative flex h-full items-center justify-center px-[120px] py-[70px]">
      {/* A small copy in the top-left corner (inside the overscan safe area)
          for TVs that crop or shift the centre of the picture. */}
      {req && (
        <div data-testid="pair-code-corner" className="absolute left-[72px] top-[56px] rounded-xl bg-surface-2 px-4 py-2 text-2xl text-muted">
          {t("tv.pair.code_label")} <span className="font-mono font-bold tracking-[0.12em] text-accent">{req.user_code}</span>
        </div>
      )}
      <div className="mr-24 flex flex-col items-center">
        <div className="flex h-[400px] w-[400px] items-center justify-center rounded-3xl bg-white p-6">
          {req && qr ? <img src={qr} alt="" className="h-full w-full" /> : <Spinner size={64} />}
        </div>
        {req && <div className="mt-5 font-mono text-4xl font-bold tracking-[0.15em] text-accent">{req.user_code}</div>}
      </div>
      <div className="max-w-[820px]">
        <Logo className="text-[44px]" />
        <h1 className="mt-6 text-5xl font-bold">{t("tv.pair.title")}</h1>
        {req && (
          <p data-testid="pair-code" className="mt-6 font-mono text-[84px] font-bold leading-none tracking-[0.15em] text-accent">
            {req.user_code}
          </p>
        )}
        <p className="mt-6 text-3xl text-muted">{t("tv.pair.scan")}</p>
        {req && <p className="mt-3 text-3xl text-muted">{t("tv.pair.or_visit", { url: req.verification_url.replace(/^https?:\/\//, "") })}</p>}
        {req && <p className="mt-3 text-2xl text-muted">{t("tv.pair.expires", { time: mmss })}</p>}
        {note && <p className="mt-3 text-2xl text-muted">{note}</p>}
        {error && <p className="mt-3 text-2xl text-danger">{error}</p>}
        <FocusButton focusKey="pair-manual" onPress={onManual} autoFocus className="mt-8 inline-block rounded-2xl bg-surface-2 px-8 py-4 text-2xl">
          {t("tv.pair.manual")}
        </FocusButton>
      </div>
    </div>
  );
}
