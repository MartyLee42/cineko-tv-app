// «Конструктивизм» pictogram shapes (see cvIcons.tsx). A chunk of its own:
// only TVs / browsers showing that design fetch it.
import type { ReactNode } from "react";
import type { CvGlyph } from "./cvIcons";

/** The red part of a pictogram. */
const R = { className: "cv-ic-a", fill: "#d7261e" } as const;
/** A screen frame (evenodd: the inside is cut out). */
const FRAME = "M1 4h22v16H1z M3.5 6.5v11h17v-11z";
/** A thick ring arc, three quarters, from the top round to the left (an arrow goes on its open end). */
const ARC = "M12 3a9 9 0 1 1-9 9h3.5a5.5 5.5 0 1 0 5.5-5.5z";

export const CV_GLYPHS: Record<CvGlyph, ReactNode> = {
  home: (
    <>
      <polygon points="12,1.5 23,11 1,11" {...R} />
      <path d="M4 11h16v11.5h-6v-6.5h-4v6.5H4z" />
    </>
  ),
  grid: (
    <>
      <rect x="2" y="2" width="9" height="9" {...R} />
      <rect x="13" y="2" width="9" height="9" />
      <rect x="2" y="13" width="9" height="9" />
      <rect x="13" y="13" width="9" height="9" />
    </>
  ),
  search: (
    <>
      <path fillRule="evenodd" d="M10 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z M10 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" />
      <circle cx="10" cy="10" r="2.6" {...R} />
      <polygon points="15.6,13.1 23,20.5 20.5,23 13.1,15.6" />
    </>
  ),
  tv: (
    <>
      <path fillRule="evenodd" d="M1 3h22v15H1z M3.5 5.5v10h17v-10z" />
      <polygon points="3.5,15.5 20.5,5.5 20.5,15.5" {...R} />
      <rect x="6" y="20" width="12" height="3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="7" r="5" {...R} />
      <path d="M2.5 23a9.5 9.5 0 0 1 19 0z" />
    </>
  ),
  shield: (
    <>
      <polygon points="12,1 22,4.5 22,12 12,23 2,12 2,4.5" />
      <polygon points="12,1 22,4.5 22,12 12,23" {...R} />
    </>
  ),
  chevronLeft: <polygon points="15,2.5 19,6.5 13.5,12 19,17.5 15,21.5 5.5,12" />,
  chevronRight: <polygon points="9,2.5 18.5,12 9,21.5 5,17.5 10.5,12 5,6.5" />,
  play: (
    <>
      <polygon points="4,2 22,12 4,22" />
      <polygon points="7,8 14,12 7,16" {...R} />
    </>
  ),
  star: <polygon points="12,1.5 14.6,9.3 22.8,9.3 16.2,14.2 18.7,22 12,17.2 5.3,22 7.8,14.2 1.2,9.3 9.4,9.3" {...R} />,
  filter: (
    <>
      <rect x="1.5" y="3.5" width="21" height="4" />
      <rect x="5" y="10" width="14" height="4" {...R} />
      <rect x="8.5" y="16.5" width="7" height="4" />
    </>
  ),
  close: (
    <>
      <polygon points="4.5,2 22,19.5 19.5,22 2,4.5" {...R} />
      <polygon points="19.5,2 22,4.5 4.5,22 2,19.5" />
    </>
  ),
  cast: (
    <>
      <path d="M1 2h22v17h-9v-3.5h5.5v-10h-15V9H1z" />
      <path d="M1 12a10 10 0 0 1 10 10H1z" {...R} />
    </>
  ),
  remote: (
    <>
      <path fillRule="evenodd" d="M6.5 1h11v22h-11z M9 12.5v3h2.5v-3z M12.5 12.5v3H15v-3z M9 17v3h2.5v-3z M12.5 17v3H15v-3z" />
      <circle cx="12" cy="6.5" r="3" {...R} />
    </>
  ),
  check: <polygon points="1.5,12.5 5,9 9.5,13.5 19,4 22.5,7.5 9.5,20.5" />,
  alert: <path fillRule="evenodd" d="M12 1.5a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21z M10.3 5.5v9h3.4v-9z M10.3 16v3h3.4v-3z" {...R} />,
  pause: (
    <>
      <rect x="4" y="3" width="6" height="18" />
      <rect x="14" y="3" width="6" height="18" {...R} />
    </>
  ),
  rewind: (
    <>
      <polygon points="12,4 12,20 1.5,12" {...R} />
      <polygon points="22.5,4 22.5,20 12,12" />
    </>
  ),
  forward: (
    <>
      <polygon points="1.5,4 12,12 1.5,20" />
      <polygon points="12,4 22.5,12 12,20" {...R} />
    </>
  ),
  next: (
    <>
      <polygon points="2,3 16,12 2,21" />
      <rect x="17.5" y="3" width="4.5" height="18" {...R} />
    </>
  ),
  volume: (
    <>
      <polygon points="1.5,8 6.5,8 13,2.5 13,21.5 6.5,16 1.5,16" />
      <rect x="15.5" y="9" width="2.6" height="6" {...R} />
      <rect x="20" y="5.5" width="2.6" height="13" {...R} />
    </>
  ),
  mute: (
    <>
      <polygon points="1.5,8 6.5,8 13,2.5 13,21.5 6.5,16 1.5,16" />
      <polygon points="15,8.5 16.5,7 23,13.5 21.5,15" {...R} />
      <polygon points="21.5,7 23,8.5 16.5,15 15,13.5" {...R} />
    </>
  ),
  list: (
    <>
      <rect x="1.5" y="3.5" width="4.5" height="4.5" {...R} />
      <rect x="8" y="4.25" width="14.5" height="3" />
      <rect x="1.5" y="9.75" width="4.5" height="4.5" {...R} />
      <rect x="8" y="10.5" width="14.5" height="3" />
      <rect x="1.5" y="16" width="4.5" height="4.5" {...R} />
      <rect x="8" y="16.75" width="14.5" height="3" />
    </>
  ),
  refresh: (
    <>
      <path d="M2.5 12a9.5 9.5 0 0 1 16.2-6.7l-2.5 2.5A6 6 0 0 0 6 12z" />
      <polygon points="22,2.5 22,10.5 14,10.5" {...R} />
      <path d="M21.5 12a9.5 9.5 0 0 1-16.2 6.7l2.5-2.5A6 6 0 0 0 18 12z" />
      <polygon points="2,21.5 2,13.5 10,13.5" {...R} />
    </>
  ),
  restart: (
    <>
      <path d={ARC} />
      <polygon points="13,-0.5 13,9.5 6,4.5" {...R} />
    </>
  ),
  history: (
    <>
      <path d={ARC} />
      <polygon points="13,-0.5 13,9.5 6,4.5" {...R} />
      <path d="M12 12V8.5A3.5 3.5 0 0 1 15.5 12z" {...R} />
    </>
  ),
  clock: (
    <>
      <path fillRule="evenodd" d="M12 1.5a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21z M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" />
      <path d="M12 12V6.5A5.5 5.5 0 0 1 17.5 12z" {...R} />
    </>
  ),
  arrowUp: (
    <>
      <polygon points="12,1.5 22,11.5 2,11.5" {...R} />
      <rect x="9" y="11.5" width="6" height="11" />
    </>
  ),
  arrowDown: (
    <>
      <rect x="9" y="1.5" width="6" height="11" />
      <polygon points="2,12.5 22,12.5 12,22.5" {...R} />
    </>
  ),
  device: (
    <>
      <path fillRule="evenodd" d="M5 1h14v22H5z M7.5 3.5v14h9v-14z" />
      <polygon points="7.5,17.5 16.5,3.5 16.5,17.5" {...R} />
    </>
  ),
  copy: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" {...R} />
      <rect x="9.5" y="9.5" width="13" height="13" />
    </>
  ),
  download: (
    <>
      <rect x="9.5" y="1.5" width="5" height="8" />
      <polygon points="3.5,9 20.5,9 12,17.5" {...R} />
      <rect x="1.5" y="19.5" width="21" height="3" />
    </>
  ),
  heart: <path d="M12 22.5 2.6 13A5.6 5.6 0 0 1 12 5.2 5.6 5.6 0 0 1 21.4 13z" {...R} />,
  heartOutline: <path fillRule="evenodd" d="M12 22.5 2.6 13A5.6 5.6 0 0 1 12 5.2 5.6 5.6 0 0 1 21.4 13z M12 17.6l6.2-6.3A2.6 2.6 0 0 0 13.6 9L12 10.8 10.4 9a2.6 2.6 0 0 0-4.6 2.3z" />,
  bookmark: <polygon points="4.5,1.5 19.5,1.5 19.5,22.5 12,16.5 4.5,22.5" {...R} />,
  bookmarkOutline: <path fillRule="evenodd" d="M4.5 1.5h15v21l-7.5-6-7.5 6z M7.5 4.5v12l4.5-3.6 4.5 3.6v-12z" />,
  bell: (
    <>
      <path d="M4.5 17.5 6.5 8a5.5 5.5 0 0 1 11 0l2 9.5z" />
      <rect x="1.5" y="16.5" width="21" height="3" />
      <circle cx="12" cy="21" r="2.5" {...R} />
    </>
  ),
  gear: (
    <>
      <rect x="9.75" y="0.5" width="4.5" height="23" />
      <rect x="0.5" y="9.75" width="23" height="4.5" />
      <rect x="9.75" y="0.5" width="4.5" height="23" transform="rotate(45 12 12)" />
      <rect x="9.75" y="0.5" width="4.5" height="23" transform="rotate(-45 12 12)" />
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.5" {...R} />
    </>
  ),
  eye: (
    <>
      <path fillRule="evenodd" d="M0.5 12C5 3.5 19 3.5 23.5 12 19 20.5 5 20.5 0.5 12z M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z" />
      <circle cx="12" cy="12" r="4" {...R} />
    </>
  ),
  eyeOff: (
    <>
      <path fillRule="evenodd" d="M0.5 12C5 3.5 19 3.5 23.5 12 19 20.5 5 20.5 0.5 12z M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z" />
      <circle cx="12" cy="12" r="4" {...R} />
      <polygon points="3,1 23,21 21,23 1,3" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M1.5 1.5h8.5V5H5v5H1.5z M22.5 1.5V10H19V5h-5V1.5z M22.5 22.5H14V19h5v-5h3.5z M1.5 22.5V14H5v5h5v3.5z" />
      <rect x="8.5" y="8.5" width="7" height="7" {...R} />
    </>
  ),
  exitFullscreen: (
    <>
      <path d="M10 1.5V10H1.5V6.5h5v-5z M22.5 10H14V1.5h3.5v5h5z M14 22.5V14h8.5v3.5h-5v5z M1.5 14H10v8.5H6.5v-5h-5z" />
      <rect x="10" y="10" width="4" height="4" {...R} />
    </>
  ),
  pip: (
    <>
      <path fillRule="evenodd" d={FRAME} />
      <rect x="11.5" y="11" width="9" height="6.5" {...R} />
    </>
  ),
  subtitles: (
    <>
      <path fillRule="evenodd" d={FRAME} />
      <rect x="5.5" y="10" width="5" height="2.6" {...R} />
      <rect x="12" y="10" width="6.5" height="2.6" />
      <rect x="5.5" y="14" width="8" height="2.6" />
      <rect x="15" y="14" width="3.5" height="2.6" {...R} />
    </>
  ),
  audio: (
    <>
      <rect x="1.5" y="9.5" width="3" height="5" />
      <rect x="6" y="5.5" width="3" height="13" {...R} />
      <rect x="10.5" y="1.5" width="3" height="21" />
      <rect x="15" y="6.5" width="3" height="11" {...R} />
      <rect x="19.5" y="9" width="3" height="6" />
    </>
  ),
  speed: (
    <>
      <path d="M1.5 19a10.5 10.5 0 0 1 21 0H19a7 7 0 0 0-14 0z" />
      <polygon points="10.4,17.6 19,7.5 13.6,20.4" {...R} />
      <circle cx="12" cy="19" r="2.5" />
    </>
  ),
  compass: (
    <>
      <path fillRule="evenodd" d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22z M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" />
      <polygon points="16.5,7.5 13.4,13.4 10.6,10.6" {...R} />
      <polygon points="7.5,16.5 10.6,10.6 13.4,13.4" />
    </>
  ),
  spark: (
    <>
      <polygon points="11,1 13.6,8.4 21,11 13.6,13.6 11,21 8.4,13.6 1,11 8.4,8.4" {...R} />
      <polygon points="19.5,14 20.8,17.2 24,18.5 20.8,19.8 19.5,23 18.2,19.8 15,18.5 18.2,17.2" />
    </>
  ),
  dice: (
    <>
      <rect x="1.5" y="1.5" width="21" height="21" />
      <rect x="4.5" y="4.5" width="4.5" height="4.5" {...R} />
      <rect x="15" y="4.5" width="4.5" height="4.5" {...R} />
      <rect x="9.75" y="9.75" width="4.5" height="4.5" {...R} />
      <rect x="4.5" y="15" width="4.5" height="4.5" {...R} />
      <rect x="15" y="15" width="4.5" height="4.5" {...R} />
    </>
  ),
  film: (
    <>
      <path fillRule="evenodd" d="M3 1h18v22H3z M5 3.5v3h2v-3z M17 3.5v3h2v-3z M5 10.5v3h2v-3z M17 10.5v3h2v-3z M5 17.5v3h2v-3z M17 17.5v3h2v-3z M8.5 5v14h7V5z" />
      <rect x="8.5" y="5" width="7" height="14" {...R} />
    </>
  ),
  newEpisodes: (
    <>
      <path fillRule="evenodd" d="M1 6.5h17v13H1z M3.5 9v8h12V9z" />
      <rect x="5.5" y="21" width="8" height="2.5" />
      <polygon points="20,0 21.3,2.7 24,4 21.3,5.3 20,8 18.7,5.3 16,4 18.7,2.7" {...R} />
    </>
  ),
  message: (
    <>
      <polygon points="1.5,2.5 22.5,2.5 22.5,17 10,17 3.5,22.5 3.5,17 1.5,17" />
      <rect x="5.5" y="6.5" width="13" height="2.8" {...R} />
      <rect x="5.5" y="11" width="8" height="2.8" {...R} />
    </>
  ),
  sliders: (
    <>
      <rect x="1.5" y="5.5" width="21" height="3" />
      <rect x="1.5" y="15.5" width="21" height="3" />
      <rect x="13" y="2.5" width="5.5" height="9" {...R} />
      <rect x="5.5" y="12.5" width="5.5" height="9" {...R} />
    </>
  ),
  more: (
    <>
      <rect x="1.5" y="9.25" width="5.5" height="5.5" />
      <rect x="9.25" y="9.25" width="5.5" height="5.5" {...R} />
      <rect x="17" y="9.25" width="5.5" height="5.5" />
    </>
  ),
  plus: (
    <>
      <rect x="9.5" y="1.5" width="5" height="21" />
      <rect x="1.5" y="9.5" width="21" height="5" {...R} />
    </>
  ),
  trailer: (
    <>
      <path fillRule="evenodd" d={FRAME} />
      <polygon points="9,8 17,12 9,16" {...R} />
    </>
  ),
  liveTv: (
    <>
      <path fillRule="evenodd" d="M1 8h22v15H1z M3.5 10.5v10h17v-10z" />
      <polygon points="6,1.5 8.5,1.5 12,5 15.5,1.5 18,1.5 12,7.5" />
      <circle cx="12" cy="15.5" r="3.2" {...R} />
    </>
  ),
  playTile: (
    <>
      <rect x="1" y="4" width="22" height="16" />
      <polygon points="9,8 17,12 9,16" {...R} />
    </>
  ),
  back: (
    <>
      <polygon points="1,12 11,2.5 11,21.5" {...R} />
      <rect x="11" y="8.5" width="12" height="7" />
    </>
  ),
  reco: (
    <>
      <polygon points="1.5,2.5 22.5,2.5 22.5,17 10,17 3.5,22.5 3.5,17 1.5,17" />
      <polygon points="12,15 7,10 9.5,6.5 12,8.5 14.5,6.5 17,10" {...R} />
    </>
  ),
};
