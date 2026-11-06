// «Обновить подборки ИИ» on the TV: an action tile at the start of Explore's
// «Подборки дня» row (the row is added when the profile has no collections).
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useActiveProfileId } from "../profile/active";

export type RegenStatus = Schemas["ForYouRegenStatus"];
type Section = Schemas["ExploreSection"];
type Tile = Schemas["ExploreTile"];

export const REGEN_TILE = "action:regen";

export function useRegenStatus() {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["foryou", "regen", profile],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: () => unwrap(api.GET("/foryou/regenerate", { params: { query: { profile_id: profile! } } })),
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : false),
  });
}

export function useRegenerate() {
  const profile = useActiveProfileId();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/foryou/regenerate", { body: { profile_id: profile! } })),
    onSuccess: (st) => queryClient.setQueryData(["foryou", "regen", profile], st),
    onError: () => void queryClient.invalidateQueries({ queryKey: ["foryou", "regen", profile] }),
  });
}

/** Puts the action tile first in the collections section (adding the section when missing). */
export function withRegenTile(sections: Section[], tile: Pick<Tile, "title" | "subtitle">, sectionTitle: string): Section[] {
  const action: Tile = { id: REGEN_TILE, kind: "collection", title: tile.title, subtitle: tile.subtitle, emoji: "↻", image_path: null, collection_id: null, discover: null } as Tile;
  const i = sections.findIndex((s) => s.kind === "collections");
  if (i < 0) return [{ id: "collections", kind: "collections", title: sectionTitle, tiles: [action] } as Section, ...sections];
  return sections.map((s, j) => (j === i ? { ...s, tiles: [action, ...s.tiles] } : s));
}
