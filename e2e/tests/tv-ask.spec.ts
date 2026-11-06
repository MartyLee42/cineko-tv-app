import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Screenshots (1920×1080) of every Ask AI state; SHOTS=<dir> overrides. */
const SHOTS = process.env.SHOTS ?? "/tmp/pw-ask/tv";

type Design = "kinozal" | "terminal" | "projector";
type Media = { id: string; title: string; kind: string; [k: string]: unknown };

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const apiError = (route: Route, status: number, code: string) => json(route, { error: { code, message: code, request_id: "r" } }, status);

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}
const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

async function shot(tv: Page, name: string) {
  await tv.waitForTimeout(600);
  await tv.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function intoMenu(tv: Page, design: Design) {
  const key = design === "kinozal" ? "ArrowLeft" : "ArrowUp";
  const inMenu = () => tv.locator('nav [data-nav-focused="1"]').count();
  await expect.poll(async () => (await inMenu()) + (await tv.locator(".is-focused").count())).toBeGreaterThan(0);
  for (let i = 0; i < 14 && !(await inMenu()); i++) await press(tv, key);
  await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
}

async function pick(tv: Page, design: Design, id: string) {
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  for (let i = 0; i < 14; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu", { timeout: 5_000 });
    if (cur === id) break;
    const forward = order.indexOf(id) > order.indexOf(cur);
    await press(tv, design === "kinozal" ? (forward ? "ArrowDown" : "ArrowUp") : forward ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

/** Presses `key` until the focus key matches (bounded). */
async function moveTo(tv: Page, key: string, want: RegExp, max = 12) {
  for (let i = 0; i < max && !want.test(await focusKey(tv)); i++) await press(tv, key);
  await expect.poll(() => focusKey(tv)).toMatch(want);
}

const WHY = ["A gentle comedy that never gets dark", "Warm, funny and short", "Feel-good road trip", "Light mystery with charm", "Cozy and clever", "Sweet romance", "Smart and breezy", "A crowd-pleaser"];

function answer(pool: Media[], prompt: string, n: number, offset = 0) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    profile_id: "p",
    prompt,
    kind: "any",
    include_watched: false,
    answer: "Here are easy-going picks for a relaxed evening together — nothing scary, all under two hours.",
    items: pool.slice(offset, offset + 8).map((m, i) => ({ media: m, why: WHY[i]! })),
    followups: ["Something shorter", "Only comedies", "More recent films"],
    refused: false,
    tokens: 2100,
    created_at: new Date().toISOString(),
  };
}

/**
 * «Спросить ИИ» on the TV in every design: the menu item, example tiles that
 * ask at once (thinking state), the answer with «почему» following focus,
 * OK → Details (feedback open/ask), follow-up chips, the on-screen keyboard,
 * the phone QR with the answer arriving over realtime (`foryou.ask`), and the
 * error states (limit, AI off).
 */
test("TV Ask AI: examples, answer, follow-ups, keyboard, phone → TV, errors in every design", async ({ browser }) => {
  test.setTimeout(420_000);
  mkdirSync(SHOTS, { recursive: true });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const home = await (await phoneCtx.request.get("/api/v1/catalog/home?lang=en")).json();
  const seen = new Set<string>();
  const pool: Media[] = [];
  for (const r of home.rows as { items: Media[] }[]) {
    for (const m of r.items) {
      if (seen.has(m.id) || pool.length >= 30) continue;
      seen.add(m.id);
      pool.push(m);
    }
  }
  expect(pool.length).toBeGreaterThan(16);

  // ---- mocked backend (installed once; the design is switched by a variable)
  let design: Design = "kinozal";
  let mode: "ok" | "limit" | "disabled" = "ok";
  const asks: { prompt: string; kind: string; profile_id: string }[] = [];
  const feedback: { action?: string; media_id?: string; row_id?: string; events?: { action: string; media_id: string; row_id?: string }[] }[] = [];
  await tvCtx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true });
  });
  await tvCtx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await tvCtx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await tvCtx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await tvCtx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
  await tvCtx.route(/\/api\/v1\/foryou\/feedback/, (route) => {
    feedback.push(route.request().postDataJSON());
    return json(route, { accepted: 1 }, 202);
  });
  await tvCtx.route(/\/api\/v1\/foryou\/asks(\?.*)?$/, (route) =>
    json(route, { items: [answer(pool, "Films like Interstellar, but lesser known", 900, 8), { ...answer(pool, "how do I cook borscht?", 901), refused: true, items: [] }], ai_enabled: true, daily_limit: 30 }),
  );
  await tvCtx.route(/\/api\/v1\/foryou\/ask(\?.*)?$/, async (route) => {
    if (mode === "limit") return apiError(route, 429, "ask_limit");
    if (mode === "disabled") return apiError(route, 503, "ai_disabled");
    const body = route.request().postDataJSON();
    asks.push(body);
    await new Promise((r) => setTimeout(r, 900)); // long enough to see «Thinking…»
    return json(route, answer(pool, body.prompt, asks.length));
  });
  // Realtime: pass everything through, keep a handle to inject `foryou.ask`.
  let socket: WebSocketRoute | null = null;
  await tvCtx.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    ws.connectToServer();
    socket = ws;
  });
  const pushFromPhone = (prompt: string) => socket!.send(JSON.stringify({ type: "foryou.ask", payload: { ...answer(pool, prompt, 77, 4), answer: "Sent from your phone: heists with style." } }));

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Ask TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const d of (process.env.DESIGNS ?? "kinozal,terminal,projector").split(",") as Design[]) {
      design = d;
      mode = "ok";
      asks.length = 0;
      feedback.length = 0;
      await tv.reload();
      await expect(tv.locator(`[data-design-shell="${d}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });

      // ---- menu → «Ask AI»: example tiles, focus on the first one, history chips.
      await intoMenu(tv, d);
      await expect(tv.locator('nav [data-menu="ask"]')).toHaveCount(1);
      await pick(tv, d, "ask");
      const screen = tv.getByTestId("ask");
      await expect(screen).toBeVisible();
      await expect.poll(() => focusKey(tv)).toBe("a-tile-light");
      await expect(screen).toContainText("Films like Interstellar, but lesser known");
      await shot(tv, `${d}-input`);

      // ---- an example asks at once: thinking, then the answer.
      await press(tv, "Enter");
      await expect(tv.getByTestId("ask-thinking")).toBeVisible();
      await shot(tv, `${d}-thinking`);
      const result = tv.getByTestId("ask-result");
      await expect(result).toBeVisible({ timeout: 10_000 });
      expect(asks[0]).toMatchObject({ prompt: "Something light for tonight, no horror, under 2 hours", kind: "any" });
      await expect(tv.getByTestId("ask-answer")).toContainText("easy-going picks");
      await expect.poll(() => focusKey(tv)).toBe(`a-card-${pool[0]!.id}`);
      const why = tv.getByTestId("ask-why");
      await expect(why).toContainText(pool[0]!.title);
      await expect(why).toContainText(WHY[0]!);
      await press(tv, "ArrowRight");
      await expect(why).toContainText(WHY[1]!);
      await shot(tv, `${d}-answer`);

      // ---- OK → Details (feedback open, row ask); Back returns to the answer.
      await press(tv, "Enter");
      await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
      await press(tv, "Escape");
      await expect(result).toBeVisible();
      await expect.poll(() => focusKey(tv)).toBe(`a-card-${pool[1]!.id}`);
      await tv.evaluate(() => window.dispatchEvent(new Event("pagehide"))); // flush the batched feedback
      await expect
        .poll(() => feedback.flatMap((f) => f.events ?? [f]).some((e) => e.action === "open" && e.media_id === pool[1]!.id && e.row_id === "ask"))
        .toBe(true);

      // ---- a follow-up chip asks again with its text.
      await moveTo(tv, "ArrowDown", /^a-fu-0$/, 3);
      await press(tv, "Enter");
      await expect.poll(() => asks.length).toBe(2);
      expect(asks[1]!.prompt).toBe("Something shorter");
      await expect(result).toBeVisible({ timeout: 10_000 });

      // ---- «New question» → the keyboard: type, then «Ask».
      await moveTo(tv, "ArrowDown", /^a-(fu-\d|new)$/, 3);
      await moveTo(tv, "ArrowRight", /^a-new$/, 4);
      await press(tv, "Enter");
      await expect.poll(() => focusKey(tv)).toBe("a-tile-light");
      await moveTo(tv, "ArrowDown", /^a-tile-heist$/, 1);
      await moveTo(tv, "ArrowRight", /^a-tile-type$/, 3);
      await press(tv, "Enter");
      const kb = tv.getByTestId("ask-keyboard");
      await expect(kb).toBeVisible();
      await tv.keyboard.type("heist movies with humor", { delay: 30 });
      await expect(tv.getByTestId("ask-text")).toHaveText("Heist movies with humor");
      await shot(tv, `${d}-keyboard`);
      await moveTo(tv, "ArrowRight", /^akb-(kind|send|close)$/, 9);
      await moveTo(tv, "ArrowDown", /^akb-send$/, 2);
      await press(tv, "Enter");
      await expect(kb).toHaveCount(0);
      await expect.poll(() => asks.length).toBe(3);
      expect(asks[2]!.prompt).toBe("Heist movies with humor");
      await expect(result).toBeVisible({ timeout: 10_000 });

      // ---- «Ask from your phone»: QR with /ask?device=…, the answer arrives over realtime.
      await moveTo(tv, "ArrowDown", /^a-(fu-\d|new)$/, 3);
      await moveTo(tv, "ArrowRight", /^a-new$/, 4);
      await press(tv, "Enter");
      await moveTo(tv, "ArrowDown", /^a-tile-heist$/, 1);
      await moveTo(tv, "ArrowRight", /^a-tile-phone$/, 4);
      await press(tv, "Enter");
      const phonePanel = tv.getByTestId("ask-phone");
      await expect(phonePanel).toBeVisible();
      await expect(tv.getByTestId("ask-qr")).toBeVisible();
      await expect(phonePanel).toContainText("/ask");
      await shot(tv, `${d}-phone`);
      pushFromPhone("Heist series with Russian dubbing");
      await expect(phonePanel).toHaveCount(0);
      await expect(result).toContainText("Asked from the phone");
      await expect(tv.getByTestId("ask-answer")).toHaveText("Sent from your phone: heists with style.");
      await expect.poll(() => focusKey(tv)).toBe(`a-card-${pool[4]!.id}`);
      await shot(tv, `${d}-from-phone`);

      // ---- from another screen the TV opens Ask AI by itself.
      await intoMenu(tv, d);
      await pick(tv, d, "home");
      await expect(tv.locator("[data-row=trending]")).toBeVisible();
      pushFromPhone("Something cozy");
      await expect(tv.getByTestId("ask-result")).toContainText("Asked from the phone", { timeout: 10_000 });

      // ---- errors (once): the daily limit and AI switched off.
      if (d === "kinozal") {
        await moveTo(tv, "ArrowDown", /^a-(fu-\d|new)$/, 3);
        await moveTo(tv, "ArrowRight", /^a-new$/, 4);
        await press(tv, "Enter");
        mode = "limit";
        await press(tv, "Enter");
        const err = tv.getByTestId("ask-error");
        await expect(err).toHaveAttribute("data-kind", "limit");
        await expect(err).toContainText("That's all for today");
        await expect.poll(() => focusKey(tv)).toBe("a-new");
        await shot(tv, `${d}-error-limit`);
        await press(tv, "Enter");
        mode = "disabled";
        await expect.poll(() => focusKey(tv)).toBe("a-tile-light");
        await press(tv, "Enter");
        await expect(err).toHaveAttribute("data-kind", "disabled");
        await expect(err).toContainText("AI is off");
        await press(tv, "Enter");
        await expect.poll(() => focusKey(tv)).toBe("a-tile-light");
      }
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (dlg) => dlg.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
