// Where the skins' own drawings go: the full-screen background layer, Home
// hero edges and the Details title plate come from the applied design's chunk
// (looks/<id>.tsx with its CSS, loaded on demand: looks/registry.ts); the
// calm-motion switch lives here. Backgrounds are
// static SVG/gradients; Каркас adds one transform-only animated layer (the
// floor), stopped in the calm mode. The design pickers' tiles: previews.tsx.
import { useSyncExternalStore, type ReactNode } from "react";
import type { DesignSetting } from "@martytv/ui";
import { storage } from "../platform";
import { useSkin } from "./context";
import { skinOf } from "./registry";
import { getLook, subscribeLooks } from "./looks/registry";
import type { Look } from "./looks/types";
import type { MenuId } from "./menuOrder";

// ================================================================ calm mode

const CALM_KEY = "martytv.calm_motion";
const calmListeners = new Set<() => void>();

function reducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** This TV's background-motion choice (device-local; default moving unless the OS asks for less motion). */
export const calmMotion = {
  get(): boolean {
    const v = storage.get(CALM_KEY);
    return v === "1" ? true : v === "0" ? false : reducedMotion();
  },
  set(v: boolean) {
    storage.set(CALM_KEY, v ? "1" : "0");
    calmListeners.forEach((l) => l());
  },
};

export function useCalmMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      calmListeners.add(l);
      return () => void calmListeners.delete(l);
    },
    () => calmMotion.get(),
  );
}

// ================================================================ background

/** The design's own components (null until its chunk is here: boot waits for the first one). */
export function useLook(id: DesignSetting): Look | null {
  return useSyncExternalStore(subscribeLooks, () => getLook(id));
}

/**
 * The applied skin's background (null for the original three). Put it first
 * in a full-screen container. `dim` (Settings, guide): no sun, a darker veil
 * for long text.
 */
export function SkinBackground({ dim = false }: { dim?: boolean }) {
  const Bg = useLook(useSkin())?.Background;
  const calm = useCalmMotion();
  if (!Bg) return null;
  return (
    <>
      <Bg calm={calm} dim={dim} />
      {dim && <div className="skin-veil pointer-events-none absolute left-0 top-0 h-[1080px] w-[1920px]" />}
    </>
  );
}

/** The skin's companion over the catalog (Тамагочи's pet, Симметрия's chapter card), if it has one. */
export function SkinCompanion({ onHome, section }: { onHome: boolean; section: MenuId | null }) {
  const Companion = useLook(useSkin())?.Companion;
  return Companion ? <Companion onHome={onHome} section={section} /> : null;
}

/** The skin draws an end card after rows and grids (HRow / VGrid). */
export function useHasSkinEnd(): boolean {
  return !!useLook(useSkin())?.End;
}

/** The skin's end card («Мультфильм»'s «Конец фильма»), if it has one. */
export function SkinEnd({ kind, width, height }: { kind: "row" | "screen"; width: number; height: number }) {
  const End = useLook(useSkin())?.End;
  return End ? <End kind={kind} width={width} height={height} /> : null;
}

// ================================================================ ornaments

/** Headline size factor of the applied skin (1 on the original designs). */
export function useTitleScale(): number {
  return skinOf(useSkin()).titleScale;
}

/** Extra layers over Home's hero artwork (Ар-деко's curtains, Каркас's grid horizon…). */
export function HeroEdges({ height }: { height: number }) {
  const id = useSkin();
  const Edges = useLook(id)?.HeroEdges;
  if (!skinOf(id).ornaments.heroEdges || !Edges) return null;
  return <Edges height={height} />;
}

/** Title size in the marquee plate (smaller than the bare title: the plate adds height above the fixed header). */
export function plateTitleSize(title: string): number {
  return title.length > 28 ? 52 : title.length > 16 ? 62 : 76;
}

/** The skin frames Details' title in a plate (Ар-деко). */
export function useTitlePlate(): boolean {
  return skinOf(useSkin()).ornaments.titlePlate;
}

/** Details title: Ар-деко frames it in a marquee plate (labelled with the kind); other skins show `eyebrow` + title. */
export function TitlePlate({ children, kind, eyebrow }: { children: ReactNode; kind: string; eyebrow: ReactNode }) {
  const id = useSkin();
  const Plate = useLook(id)?.TitlePlate;
  if (!skinOf(id).ornaments.titlePlate || !Plate)
    return (
      <>
        {eyebrow}
        {children}
      </>
    );
  return <Plate kind={kind}>{children}</Plate>;
}
