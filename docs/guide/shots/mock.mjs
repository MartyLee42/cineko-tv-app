// A fictional catalog for guide screenshots: titles, posters (generated SVG),
// releases and a playable clip. No TMDB, no real titles or people.
import { readFileSync } from "node:fs";

export const uid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const PALETTES = [
  ["#0f2027", "#2c5364", "#f9d423"], ["#41295a", "#2f0743", "#ff6a88"], ["#1d2b64", "#f8cdda", "#ffffff"],
  ["#232526", "#414345", "#e94057"], ["#134e5e", "#71b280", "#fdfc47"], ["#3a1c71", "#d76d77", "#ffaf7b"],
  ["#000428", "#004e92", "#7ee8fa"], ["#200122", "#6f0000", "#ffb347"], ["#0b486b", "#f56217", "#fff3b0"],
  ["#16222a", "#3a6073", "#c6ffdd"], ["#4b134f", "#c94b4b", "#ffe29f"], ["#1f1c2c", "#928dab", "#f7ff00"],
  ["#2b5876", "#4e4376", "#ffd6a5"], ["#093028", "#237a57", "#f0f2f0"], ["#3e5151", "#decba4", "#2d2d2d"],
  ["#141e30", "#243b55", "#ff9966"], ["#42275a", "#734b6d", "#a8ff78"], ["#000000", "#434343", "#ff0844"],
];

// [title, original, year, kind, genres, rating, runtime, overview]
const TITLES = [
  ["Северный ветер", "North Wind", 2024, "movie", [18, 12], 8.1, 128, "Метеоролог остаётся одна на полярной станции, когда связь с большой землёй пропадает."],
  ["Последний рейс", "The Last Flight", 2023, "movie", [53, 28], 7.4, 112, "Пилот ночного рейса понимает, что один из пассажиров знает о самолёте больше экипажа."],
  ["Тихая гавань", "Quiet Harbour", 2022, "movie", [18, 10749], 7.8, 104, "Двое старых друзей встречаются в приморском городке, где когда-то провели одно лето."],
  ["Код доступа", "Access Code", 2025, "movie", [878, 53], 7.2, 118, "Программистка находит в старом коде сообщение, адресованное лично ей."],
  ["Кот в шляпе", "The Hat Shop Cat", 2021, "movie", [16, 10751, 35], 7.9, 92, "Рыжий кот открывает шляпную лавку и случайно спасает весь квартал."],
  ["Полночный экспресс", "Midnight Line", 2024, "movie", [80, 9648], 7.6, 121, "Следователь распутывает исчезновение в поезде, который не делает остановок."],
  ["Сад камней", "Stone Garden", 2020, "movie", [18], 8.3, 135, "Неторопливая история о семье, которая три поколения ухаживает за одним садом."],
  ["Гром над холмами", "Thunder Over the Hills", 2019, "movie", [37, 12], 7.0, 126, "Бывший шериф ведёт караван через перевал, где хозяйничают бандиты."],
  ["Звёздная пыль", "Stardust Drift", 2025, "movie", [878, 12], 8.0, 141, "Экипаж грузового корабля находит в поясе астероидов то, чего там быть не может."],
  ["Смешные люди", "Funny People Club", 2023, "movie", [35], 6.9, 98, "Четверо неудачников открывают клуб стендапа в гараже — и он внезапно становится модным."],
  ["Остров туманов", "Island of Fog", 2022, "movie", [27, 9648], 6.8, 101, "Исследователи прибывают на остров, где туман приходит строго по расписанию."],
  ["Большая весна", "The Big Spring", 2021, "movie", [10751, 18], 7.7, 109, "Девочка и её дед готовят старый трактор к весенней ярмарке."],
  ["Неон", "Neon", 2024, "movie", [28, 878], 7.1, 115, "Курьер в городе будущего получает посылку, за которой охотятся все."],
  ["Лето в Провансе", "Provence Summer", 2020, "movie", [35, 10749], 7.3, 103, "Повар из Москвы получает в наследство ресторан на юге Франции."],
  ["Тень маяка", "Lighthouse Shadow", 2023, "movie", [9648, 18], 7.9, 117, "Смотритель маяка замечает, что свет каждую ночь гаснет на одну минуту."],
  ["Робот и девочка", "The Robot and the Girl", 2025, "movie", [16, 878, 10751], 8.4, 96, "Маленький робот-уборщик помогает девочке найти дорогу домой."],
  ["Дом у реки", "House by the River", 2019, "series", [18, 9648], 8.6, 52, "Семейная драма: старый дом хранит тайны каждого, кто в нём жил."],
  ["Отдел 17", "Department 17", 2022, "series", [80, 18], 8.2, 48, "Небольшой отдел полиции берётся за дела, от которых отказались все остальные."],
  ["Станция «Заря»", "Zarya Station", 2024, "series", [878, 18], 8.0, 55, "Экипаж орбитальной станции остаётся без связи с Землёй на полгода."],
  ["Повара", "The Cooks", 2023, "series", [35], 7.6, 30, "Комедия о самой шумной кухне в городе и её невозмутимом шеф-поваре."],
  ["Хроники долины", "Valley Chronicles", 2021, "series", [10765, 12], 8.3, 58, "Фэнтези-сага о долине, где у каждой реки есть свой хранитель."],
  ["Школа чудес", "School of Wonders", 2025, "series", [16, 10751], 7.8, 24, "Мультсериал об учениках школы, где на переменах оживают рисунки."],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A poster/backdrop/still SVG; `w`×`h`, artwork chosen from the title. */
export function art(title, w, h, withTitle = true) {
  const k = hash(title);
  const [a, b, c] = PALETTES[k % PALETTES.length];
  const motif = k % 5;
  const cx = w * (0.3 + ((k >> 3) % 40) / 100), cy = h * (0.28 + ((k >> 5) % 20) / 100), r = Math.min(w, h) * 0.22;
  let shapes = "";
  if (motif === 0) shapes = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" opacity=".9"/><path d="M0 ${h * 0.72} L${w * 0.3} ${h * 0.52} L${w * 0.55} ${h * 0.68} L${w * 0.8} ${h * 0.48} L${w} ${h * 0.62} L${w} ${h} L0 ${h}Z" fill="#000" opacity=".55"/>`;
  else if (motif === 1) shapes = [0, 1, 2, 3, 4].map((i) => `<rect x="${(i * w) / 5}" y="${h * (0.4 + (i % 2) * 0.12)}" width="${w / 5 - 6}" height="${h}" fill="#000" opacity="${0.25 + i * 0.08}"/>`).join("") + `<circle cx="${cx}" cy="${cy * 0.8}" r="${r * 0.6}" fill="${c}"/>`;
  else if (motif === 2) shapes = [0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${w / 2}" cy="${h * 0.42}" r="${r * (0.4 + i * 0.35)}" fill="none" stroke="${c}" stroke-width="${3 + i}" opacity="${0.9 - i * 0.13}"/>`).join("");
  else if (motif === 3) shapes = `<path d="M${w * 0.1} ${h} L${w / 2} ${h * 0.25} L${w * 0.9} ${h}Z" fill="${c}" opacity=".85"/><path d="M${w * 0.3} ${h} L${w / 2} ${h * 0.55} L${w * 0.7} ${h}Z" fill="#000" opacity=".5"/>`;
  else shapes = `<ellipse cx="${w / 2}" cy="${h * 0.62}" rx="${w * 0.5}" ry="${h * 0.12}" fill="#000" opacity=".4"/><rect x="${w * 0.42}" y="${h * 0.3}" width="${w * 0.16}" height="${h * 0.34}" rx="${w * 0.03}" fill="${c}"/><circle cx="${w / 2}" cy="${h * 0.26}" r="${w * 0.09}" fill="${c}"/>`;
  const fs = Math.round(Math.min(w / 8, (w * 1.3) / title.length));
  const text = withTitle
    ? `<text x="${w / 2}" y="${h * 0.87}" font-family="Georgia, 'DejaVu Serif', serif" font-weight="700" font-size="${fs}" fill="#fff" text-anchor="middle" style="letter-spacing:1px">${esc(title.toUpperCase())}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><radialGradient id="v" cx=".5" cy=".4" r=".8"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${shapes}<rect width="${w}" height="${h}" fill="url(#v)"/>${text}</svg>`;
}

/** A face-ish avatar for cast photos. */
function face(name, w, h) {
  const k = hash(name);
  const [a, b] = PALETTES[k % PALETTES.length];
  const skin = ["#f1c27d", "#e0ac69", "#c68642", "#ffdbac", "#8d5524"][k % 5];
  const hair = ["#2b1d0e", "#5a3825", "#111", "#b55239", "#d6c4a8"][(k >> 2) % 5];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 100 150"><rect width="100" height="150" fill="${a}"/><ellipse cx="50" cy="150" rx="40" ry="38" fill="${b}"/><ellipse cx="50" cy="62" rx="22" ry="27" fill="${skin}"/><path d="M27 58 Q30 28 50 30 Q72 28 73 58 Q66 40 50 42 Q34 40 27 58Z" fill="${hair}"/></svg>`;
}

const PEOPLE = ["Анна Северова", "Дмитрий Ветров", "Ольга Морозова", "Сергей Ясенев", "Елена Белова", "Павел Орлов", "Ксения Гранина", "Алексей Кедров", "Ирина Полякова", "Глеб Рощин", "Вера Звонарёва", "Мария Лесная"];
const person = (i) => PEOPLE[i % PEOPLE.length];

const GENRES = { 12: "приключения", 16: "мультфильм", 18: "драма", 27: "ужасы", 28: "боевик", 35: "комедия", 37: "вестерн", 53: "триллер", 80: "криминал", 878: "фантастика", 9648: "детектив", 10749: "мелодрама", 10751: "семейный", 10765: "фэнтези" };

export const ITEMS = TITLES.map(([title, original_title, year, kind, genre_ids, rating, runtime, overview], i) => ({
  id: uid(i + 1),
  kind,
  tmdb_id: 900000 + i,
  title,
  original_title,
  year,
  release_date: `${year}-0${(i % 9) + 1}-1${i % 9}`,
  overview,
  poster_path: `/poster-${i + 1}.svg`,
  backdrop_path: `/backdrop-${i + 1}.svg`,
  rating,
  vote_count: 1200 + i * 137,
  kp_rating: Math.round((rating - 0.2 + (i % 3) * 0.2) * 10) / 10,
  imdb_rating: Math.round((rating - 0.1) * 10) / 10,
  genre_ids,
  award_badge: null,
  me: { progress_percent: null, completed: false, in_watchlist: false, favorite: false, rating: null },
  _runtime: runtime,
}));
export const byId = new Map(ITEMS.map((m) => [m.id, m]));
export const summary = ({ _runtime, ...m }) => m;
export const MOVIES = ITEMS.filter((m) => m.kind === "movie");
export const SERIES = ITEMS.filter((m) => m.kind === "series");

export function detail(m) {
  const h = hash(m.title);
  const cast = Array.from({ length: 10 }, (_, j) => ({ tmdb_id: 800000 + ((j + h) % 12), name: person(j + h), character: ["Вера", "Капитан Лебедев", "Доктор Ким", "Марк", "Соня", "Старик", "Голос радио", "Тимофей", "Лиза", "Алина"][j], profile_path: `/face-${(j + h) % 12}.svg`, order: j }));
  const crew = [
    { tmdb_id: 700001, name: person(h + 3), job: m.kind === "series" ? "Creator" : "Director", department: "Directing", profile_path: null },
    { tmdb_id: 700002, name: person(h + 7), job: "Original Music Composer", department: "Sound", profile_path: null },
  ];
  const seasons = m.kind === "series" ? [1, 2, 3].map((n) => ({ season_number: n, name: `Сезон ${n}`, episode_count: 8, air_date: `${m.year + n - 1}-03-01`, poster_path: m.poster_path, overview: "" })) : [];
  return {
    ...summary(m),
    tagline: "",
    runtime: m._runtime,
    status: m.kind === "series" ? "Returning Series" : "Released",
    original_language: "ru",
    genres: m.genre_ids.map((id) => ({ id, name: GENRES[id] ?? "драма" })),
    countries: ["RU"],
    cast,
    crew,
    seasons,
    number_of_seasons: seasons.length || null,
    number_of_episodes: seasons.length ? 24 : null,
    last_air_date: null,
    external_ids: { tmdb: m.tmdb_id, imdb: null, tvdb: null, kinopoisk: null },
    trailer: null,
    awards: [],
  };
}

const EP_NAMES = ["Пилот", "Старые письма", "Ночная смена", "Чужие ключи", "Шторм", "Ложный след", "Возвращение", "Финал сезона"];
export function season(m, n) {
  return {
    season_number: n, name: `Сезон ${n}`, episode_count: 8, air_date: `${m.year + n - 1}-03-01`, poster_path: m.poster_path, overview: "",
    media_id: m.id,
    episodes: EP_NAMES.map((name, j) => ({ id: uid(5000 + n * 100 + j), season_number: n, episode_number: j + 1, name, overview: "Герои узнают, что у каждого в доме есть своя причина молчать.", air_date: `${m.year + n - 1}-03-${String(1 + j * 3).padStart(2, "0")}`, runtime: m._runtime, still_path: `/still-${m.tmdb_id}-${n}-${j}.svg`, rating: 7.5 + (j % 4) * 0.3 })),
  };
}

export const page = (items) => ({ items: items.map(summary), page: 1, total_pages: 1, total_results: items.length });

const rel = (id, p) => ({ id, title: `Severny.Veter.2024.${id}`, indexer: "RuTracker", size_bytes: 14.6 * 1024 ** 3, seeders: 847, leechers: 3, published_at: null, info_hash: null, resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["aac"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }], release_group: null, source_quality: "web-dl", year: 2024, seasons: [], episodes: [], is_season_pack: false, confidence: 0.97, score: 1, reasons: [], warnings: [], ...p });
export const RELEASES = [
  rel("rel-good", { score: 10, title: "Severny.Veter.2024.1080p.WEB-DL.MVO", size_bytes: 9.1 * 1024 ** 3, seeders: 433, voiceovers: [{ kind: "mvo", studio: null, language: "ru" }] }),
  rel("b", { score: 0, confidence: 0.9, title: "Severny.Veter.2024.2160p.HDR10.TrueHD", resolution: "2160p", hdr: "hdr10", video_codec: "hevc", audio_codecs: ["truehd"], size_bytes: 61.4 * 1024 ** 3, seeders: 312, indexer: "Kinozal" }),
  rel("c", { score: 0, confidence: 0.9, title: "Severny.Veter.2024.2160p.HEVC.AC3", resolution: "2160p", video_codec: "hevc", audio_codecs: ["ac3"], indexer: "Kinozal", size_bytes: 24.8 * 1024 ** 3, seeders: 196 }),
  rel("d", { indexer: "NNM", size_bytes: 4.2 * 1024 ** 3, seeders: 233 }),
  rel("e", { resolution: "720p", indexer: "Rutor", size_bytes: 2.1 * 1024 ** 3, seeders: 402 }),
  rel("f", { indexer: "1337x", voiceovers: [{ kind: "original", studio: null, language: "en" }], languages: ["en"], size_bytes: 11.9 * 1024 ** 3, seeders: 58 }),
];

export const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const svg = (route, body) => route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "Cache-Control": "max-age=3600" }, body });

const CLIP = readFileSync(process.env.CLIP ?? "/repo/e2e/fixtures/clip.webm");

/**
 * Routes the catalog, title pages, releases and a playable source onto `ctx`.
 * opts.continue: media ids shown as «Продолжить»; opts.holdSource: keep the loader up.
 */
export async function mockCatalog(ctx, opts = {}) {
  const cont = opts.continue ?? [];
  await ctx.route(/\/api\/v1\/images\/[^/]+\/(.+)$/, (route) => {
    const f = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    let m;
    if ((m = /^poster-(\d+)/.exec(f))) return svg(route, art(ITEMS[+m[1] - 1].title, 500, 750));
    if ((m = /^backdrop-(\d+)/.exec(f))) return svg(route, art(ITEMS[+m[1] - 1].title + "~", 1280, 720, false));
    if ((m = /^face-(\d+)/.exec(f))) return svg(route, face(person(+m[1]), 200, 300));
    return svg(route, art(f, 640, 360, false));
  });
  await ctx.route(/\/api\/v1\/catalog\/config/, (route) => json(route, { image_base_url: "/api/v1/images", poster_sizes: ["w185", "w342", "w500", "original"], backdrop_sizes: ["w780", "w1280", "original"], profile_sizes: ["w185", "h632"], still_sizes: ["w300", "original"], attribution: "Демо-каталог", region: "RU", available: true }));
  await ctx.route(/\/api\/v1\/catalog\/home/, (route) => json(route, { rows: [
    { key: "trending", kind: "all", list: "trending", items: page([ITEMS[8], ITEMS[16], ITEMS[0], ITEMS[3], ITEMS[18], ITEMS[5], ITEMS[15], ITEMS[12], ITEMS[1], ITEMS[20]]).items },
    { key: "popular_movies", kind: "movie", list: "popular", items: page([...MOVIES].reverse()).items },
    { key: "popular_series", kind: "series", list: "popular", items: page(SERIES).items },
    { key: "top_rated_movies", kind: "movie", list: "top_rated", items: page([...MOVIES].sort((a, b) => b.rating - a.rating)).items },
  ] }));
  await ctx.route(/\/api\/v1\/catalog\/(lists|discover|search)/, (route) => {
    const u = new URL(route.request().url());
    const kind = u.searchParams.get("kind");
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    let items = kind === "movie" ? MOVIES : kind === "series" ? SERIES : ITEMS;
    if (q) items = items.filter((m) => m.title.toLowerCase().includes(q) || m.original_title.toLowerCase().includes(q));
    return json(route, page(items));
  });
  await ctx.route(/\/api\/v1\/catalog\/genres/, (route) => json(route, { items: Object.entries(GENRES).map(([id, name]) => ({ id: +id, name: name[0].toUpperCase() + name.slice(1) })) }));
  await ctx.route(/\/api\/v1\/media\/[^/?]+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const m = byId.get(id);
    return m ? json(route, detail(m)) : json(route, { error: { code: "not_found", message: "no" } }, 404);
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/seasons\/\d+/, (route) => {
    const p = new URL(route.request().url()).pathname.split("/");
    return json(route, season(byId.get(p[4]) ?? SERIES[0], +p[6]));
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/(similar|recommendations)/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    const m = byId.get(id);
    return json(route, page(ITEMS.filter((x) => x.id !== id && x.kind === (m?.kind ?? "movie"))));
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/providers/, (route) => json(route, { link: null, flatrate: [], rent: [], buy: [], free: [], ads: [], region: "RU" }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    const m = byId.get(id);
    const c = cont.includes(id) && m?.kind === "movie";
    return json(route, { media_id: id, kind: m?.kind ?? "movie", movie: c ? { media_id: id, episode_id: null, season_number: null, episode_number: null, position_seconds: 3725, duration_seconds: (m._runtime ?? 120) * 60, percent: 0.48, completed: false, completed_at: null, updated_at: new Date().toISOString(), device_id: null } : null, episodes: [], seasons: [], next_up: null });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: cont.map((id, i) => {
    const m = byId.get(id);
    const series = m.kind === "series";
    return { media: summary({ ...m, me: { ...m.me, progress_percent: 0.3 + i * 0.15 } }), progress: { media_id: id, episode_id: series ? uid(5203) : null, season_number: series ? 2 : null, episode_number: series ? 4 : null, position_seconds: 1800, duration_seconds: 6000, percent: 0.3 + i * 0.15, completed: false, completed_at: null, updated_at: new Date().toISOString(), device_id: null } };
  }) }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/quotes/, (route) => json(route, { items: [{ text: "Ветер всегда возвращается туда, где его ждут.", speaker: "Вера" }, { text: "На станции нет плохой погоды — есть только плохие приборы.", speaker: "Капитан Лебедев" }, { text: "Если долго смотреть на снег, он начинает смотреть на тебя.", speaker: "Доктор Ким" }], source: "wikiquote", source_url: null, lang: "ru" }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/facts/, (route) => json(route, { items: [{ text: "Почти все сцены на станции снимали в павильоне, а снег делали из картофельных хлопьев.", kind: "fact", spoiler: false }, { text: "Чтобы актёры мёрзли по-настоящему, в павильоне держали плюс четыре градуса.", kind: "fact", spoiler: false }, { text: "В одной сцене у героини часы на правой руке, а через секунду — на левой.", kind: "blooper", spoiler: false }, { text: "Финальный сигнал по радио — голос самого режиссёра.", kind: "fact", spoiler: true }], source: "ai", source_url: null, lang: "ru" }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/companion/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    const series = byId.get(id)?.kind === "series";
    return json(route, { ai_enabled: true, daily_limit: 20, used_today: 2, recap: { available: series, last_watched_at: new Date(Date.now() - 12 * 86400_000).toISOString(), through: series ? { season: 2, episode: 4 } : null, cached: true }, after_credits: { available: !series || !!opts.afterSeries, scope: series ? "season" : "movie", season: series ? 1 : null } });
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/recap/, (route) => json(route, { lines: ["Дом у реки достался Наде после смерти бабушки — вместе с запертой комнатой на чердаке.", "Брат Нади Илья вернулся из города и уверен, что дом нужно продать.", "Соседка призналась, что видела в окне чердака свет, хотя ключа ни у кого нет.", "В конце 4-й серии Надя нашла в старом письме адрес, которого нет ни на одной карте."], through: { season: 2, episode: 4 }, episodes: 12, cached: true, generated_at: new Date().toISOString() }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/after-credits(\?.*)?$/, (route) => json(route, { topic: "ending", known: true, paragraphs: ["Финал оставляет главную героиню на станции не потому, что помощь не пришла, а потому, что она сама решает остаться: сигнал, который она ловила весь фильм, оказывается её собственным, записанным год назад.", "Последний кадр с открытой дверью — ответ на сцену из начала: тогда она боялась выйти в метель, теперь выходит без страха."], scope: "movie", season: null, cached: true, generated_at: new Date().toISOString() }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: uid(99999), resume_position_seconds: null, progress: null, report_token: "x" }, 201));
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  // A playable source: the e2e test clip (VP8/Opus) with chapters.
  let polls = 0;
  let lastMedia = ITEMS[0].id;
  const source = () => ({
    id: uid(77777), media_id: lastMedia, episode_id: null, release: RELEASES[0], status: polls >= 1 ? "ready" : "preparing", error: null,
    file: { index: 0, path: "Movie/film.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
    stream_url: "/api/v1/stream/tok-good", stream_expires_at: new Date(Date.now() + 3600_000).toISOString(), mime_type: "video/webm",
    media_info: { container: "matroska,webm", video_codec: "vp8", width: 320, height: 180, duration_seconds: 40, audio: [{ index: 1, codec: "opus", language: "ru", title: "Многоголосый", channels: 2, default: true }, { index: 3, codec: "opus", language: "en", title: "Original", channels: 2, default: false }], subtitles: [{ index: 2, codec: "subrip", language: "ru", title: "Русские", channels: null, default: false }], chapters: opts.chapters ?? [] },
    markers: opts.markers ?? [],
    torrent: { peers: 23, seeders: 433, download_speed_bps: 6_400_000, preloaded_bytes: 64_000_000 },
    created_at: new Date().toISOString(),
  });
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") { polls = 0; lastMedia = req.postDataJSON()?.media_id ?? lastMedia; return json(route, source(), 201); }
    if (req.method() === "DELETE") return route.fulfill({ status: 204 });
    if (opts.holdSource) return json(route, { ...source(), status: "preparing", torrent: { peers: 9, seeders: 433, download_speed_bps: 4_800_000, preloaded_bytes: 21_000_000 } });
    polls++;
    return json(route, source());
  });
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes" }, body: CLIP });
    const start = +m[1], end = m[2] ? Math.min(+m[2], CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({ status: 206, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` }, body: CLIP.subarray(start, end + 1) });
  });
  await ctx.route(/\/api\/v1\/status$/, (route) => json(route, { torrserver: { ok: true, latency_ms: 4 }, prowlarr: { ok: true }, active_streams: 1, server_time: new Date().toISOString(), seasonal_effects: false, cpu_percent: 21.5 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
}

const reason = (type, p = {}) => ({ type, text: "", media_id: null, media_title: null, person_tmdb_id: null, person_name: null, genre_ids: [], genre_names: [], collection_id: null, collection_title: null, mood: null, ...p });
const AI = ["Тихая и красивая, как любимый вами «Сад камней», но с напряжённым финалом", "Вы любите истории про одиночество и север — здесь их много", "Короткий и смешной — то, что нужно после тяжёлого дня", "Ваша любимая фантастика, но без перестрелок", "Тёплая семейная история — у вас таких много в «Избранном»"];

/** «Для вас» rows: AI-ranked top picks with personal reasons, a theme row, an AI rubric. */
export async function mockForYou(ctx, profileId) {
  const it = (m, r) => ({ media: summary(m), reason: r, score: 1 });
  const top = [ITEMS[0], ITEMS[14], ITEMS[9], ITEMS[8], ITEMS[11], ITEMS[6], ITEMS[2]].map((m, i) => it(m, reason("genre", { text: "Популярное в ваших жанрах", ai_text: AI[i % AI.length] })));
  const theme = reason("theme", { text: "Вам нравятся фильмы про космос", keyword_id: 9882, keyword_name: "космос", keyword_localized: true });
  const coll = reason("ai_collection", { collection_id: uid(4242), collection_title: "Кино для дождливого вечера", text: "Подборка: Кино для дождливого вечера" });
  const body = {
    profile_id: profileId, generated_at: new Date().toISOString(), stale: false, cold_start: false,
    rows: [
      { id: "top_picks", kind: "top_picks", title: "Подобрано для вас", reason: reason("genre"), items: top },
      { id: "theme:9882", kind: "theme", title: "Вам нравятся фильмы про космос", reason: theme, items: [ITEMS[8], ITEMS[3], ITEMS[15], ITEMS[12], ITEMS[18]].map((m) => it(m, theme)) },
      { id: `ai:${uid(4242)}`, kind: "ai_collection", title: "Кино для дождливого вечера", reason: coll, items: [ITEMS[2], ITEMS[6], ITEMS[14], ITEMS[13], ITEMS[16], ITEMS[10]].map((m) => it(m, coll)) },
    ],
  };
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, body));
}
