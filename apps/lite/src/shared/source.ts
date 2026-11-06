// Online availability of a title (CDNVideoHub by IMDb id), checked lazily on
// the title page and by the player.
import { useEffect, useState } from "react";
import { fetchPlaylist, movieVoices, seriesIndex, type Playlist, type SeasonEntry, type Voice } from "../core/cvh";
import { imdbOf, type Details, type MediaType } from "../core/tmdb";

export interface Source {
  status: "loading" | "ready" | "none" | "error";
  playlist?: Playlist;
  /** Movies: every voice-over. */
  voices: Voice[];
  /** Series: seasons → episodes → voices. */
  seasons: SeasonEntry[];
  retry: () => void;
}

export function sourceFrom(type: MediaType, pl: Playlist): Pick<Source, "voices" | "seasons" | "status"> {
  const voices = type === "movie" ? movieVoices(pl) : [];
  const seasons = type === "tv" ? seriesIndex(pl) : [];
  const has = type === "movie" ? voices.length > 0 : seasons.length > 0;
  return { voices, seasons, status: has ? "ready" : "none" };
}

export function useSource(type: MediaType, d: Details | undefined): Source {
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<Omit<Source, "retry">>({ status: "loading", voices: [], seasons: [] });
  const imdb = d ? imdbOf(d) : "";
  useEffect(() => {
    if (!d) return;
    if (!imdb) {
      setSt({ status: "none", voices: [], seasons: [] });
      return;
    }
    let alive = true;
    setSt({ status: "loading", voices: [], seasons: [] });
    fetchPlaylist(imdb).then(
      (pl) => alive && setSt({ playlist: pl, ...sourceFrom(type, pl) }),
      () => alive && setSt({ status: "error", voices: [], seasons: [] }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imdb, type, nonce, !!d]);
  return { ...st, retry: () => setNonce((n) => n + 1) };
}

export interface EpisodeRef {
  season: number;
  episode: number;
}

/** The episode after/before `cur` among the ones the source has. */
export function neighbour(seasons: SeasonEntry[], cur: EpisodeRef, dir: 1 | -1): EpisodeRef | null {
  const flat: EpisodeRef[] = [];
  for (const s of seasons) for (const e of s.episodes) flat.push({ season: s.season, episode: e.episode });
  const i = flat.findIndex((x) => x.season === cur.season && x.episode === cur.episode);
  if (i < 0) {
    // Not in the list: the first one after (or before) it.
    if (dir === 1) return flat.find((x) => x.season > cur.season || (x.season === cur.season && x.episode > cur.episode)) ?? null;
    return [...flat].reverse().find((x) => x.season < cur.season || (x.season === cur.season && x.episode < cur.episode)) ?? null;
  }
  return flat[i + dir] ?? null;
}
