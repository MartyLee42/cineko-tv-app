import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { api, type Album, type Artist, type DzPlaylist, type Library, type Track } from "./api";
import { toast } from "./toast";

export function useLibrary() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["library"], queryFn: () => api.get<Library>("/library"), staleTime: 60_000 });
  const lib = q.data;
  const likes = useMemo(() => new Set(lib?.likes ?? []), [lib]);
  const saved = useMemo(() => new Set((lib?.saved ?? []).map((s) => `${s.kind}:${s.id}`)), [lib]);

  const patch = useCallback(
    (f: (l: Library) => Library) => qc.setQueryData<Library>(["library"], (l) => (l ? f(l) : l)),
    [qc],
  );

  const toggleLike = useCallback(
    async (t: Track) => {
      const liked = likes.has(t.id);
      patch((l) => ({ ...l, likes: liked ? l.likes.filter((x) => x !== t.id) : [...l.likes, t.id] }));
      try {
        if (liked) await api.del(`/likes/${encodeURIComponent(t.id)}`);
        else await api.put("/likes", t);
        toast(liked ? "Удалено из любимых" : "Добавлено в любимые");
      } catch (e) {
        toast((e as Error).message);
      }
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["likes"] });
    },
    [likes, patch, qc],
  );

  const toggleSaved = useCallback(
    async (kind: "album" | "artist" | "playlist", item: Album | Artist | DzPlaylist) => {
      const key = `${kind}:${item.id}`;
      const on = saved.has(key);
      patch((l) => ({
        ...l,
        saved: on
          ? l.saved.filter((s) => !(s.kind === kind && s.id === String(item.id)))
          : [{ kind, id: String(item.id), data: item as Album & Artist & DzPlaylist, addedAt: Date.now() / 1000 }, ...l.saved],
      }));
      try {
        // Snapshot without the track list (kept small).
        const { tracks: _t, ...data } = item as Album;
        if (on) await api.del(`/saved/${kind}/${item.id}`);
        else await api.put(`/saved/${kind}/${item.id}`, data);
        const word = kind === "artist" ? (on ? "Вы отписались" : "Вы подписаны") : on ? "Удалено из медиатеки" : "Добавлено в медиатеку";
        toast(word);
      } catch (e) {
        toast((e as Error).message);
      }
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
    [saved, patch, qc],
  );

  const createPlaylist = useCallback(
    async (name: string, tracks: Track[] = []) => {
      const r = await api.post<{ id: number }>("/playlists", { name, tracks });
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast(`Плейлист «${name}» создан`);
      return r.id;
    },
    [qc],
  );

  const addToPlaylist = useCallback(
    async (id: number, tracks: Track[], name?: string) => {
      try {
        await api.post(`/playlists/${id}/tracks`, { tracks });
        toast(name ? `Добавлено в «${name}»` : "Добавлено в плейлист");
      } catch (e) {
        toast((e as Error).message);
      }
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["myplaylist", id] });
    },
    [qc],
  );

  return {
    loading: q.isLoading,
    playlists: lib?.playlists ?? [],
    savedItems: lib?.saved ?? [],
    likesCount: lib?.likes.length ?? 0,
    isLiked: (id: string) => likes.has(id),
    isSaved: (kind: string, id: number | string) => saved.has(`${kind}:${id}`),
    toggleLike,
    toggleSaved,
    createPlaylist,
    addToPlaylist,
  };
}
