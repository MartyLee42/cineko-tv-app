# Cineko — ideas for what's next

A shortlist of improvements that would make the biggest difference for a family that watches together on one TV and several phones. Ordered by **value ÷ effort** inside each section; ★ marks the ones worth doing first.

Status as of November 2026: catalogue, torrents via TorrServer, TV app (MSX/Tizen), phone remote, compat audio/video conversion, IPTV with programme, «Видео» (YouTube via Invidious), «Для вас» + AI, family sharing, «Подборки», awards.

---

## 1. Watching: fewer failed starts, faster starts

- ★ **"It will play" guarantee before you press Play.** For the top 3 ranked releases, add the torrent *paused* in the background, read the file list and ffprobe the first MB (container, codecs, 10-bit, audio), then drop it if nobody plays it within 10 min. The picker then shows certain verdicts («играет», «конвертируется», «не заиграет») instead of title-based guesses — this kills the AVI/10-bit/DTS surprises at the root. Must never touch torrents that Lampa added.
- ★ **Learn from what actually happened.** Every playback already reports decode errors, rebuffering and switches. Store a per-release "outcome" (played > 5 min / failed / switched away) and use it in ranking for everyone: a release that failed on the Samsung twice sinks; one that played fine rises. Cheap, and it gets smarter every evening.
- **Auto-fallback without asking.** If the first second of video never arrives in N seconds or the decoder errors twice, silently try the next release (keeping position), with a small «переключились на другую раздачу» toast and an undo.
- **Pre-warm "Next episode".** At 85 % of an episode, prepare the next one (resolve source, add paused, buffer 20 MB) so «Следующая серия» starts instantly.
- **Server-side download for slow torrents, smarter.** Offer «скачать на сервер» automatically when measured speed < bitrate and the film is in the watchlist — start it at night, ready by evening.
- **Subtitles everywhere.** Fetch Russian/English subtitles from OpenSubtitles when the release has none; per-profile default language; size/position settings on TV; translate on the fly with AI for rare languages.
- **Skip intro / recap / credits** for series from crowd data: when 2+ family members skip the same span of an episode, offer «Пропустить заставку» for that span on later episodes.

## 2. Finding what to watch tonight

- ★ **«Что посмотрим вместе?» — group pick.** Choose who is on the sofa (2–4 profiles); score candidates by the *intersection* of tastes (nobody's dislikes, unseen by all, fits the time available). One button on TV Home; result explained («всем нравится Нолан, никто не видел, 2 ч 10 мин»).
- ★ **Time-aware suggestions.** «Есть 1,5 часа» → only films that end before bedtime; at 23:00 suggest shorter titles or an episode; weekend afternoons → family films for Carina.
- **Mood + occasion in one sentence** («что-то тёплое на вечер с мамой») via «Спросить ИИ», returning playable releases only (pre-checked as in §1).
- **«Подборки» 2.0.**
  - Progress badges and «завершённые подборки» achievements per profile (finish Tarkovsky's 10 → a sticker for Marty the cat).
  - **Course mode**: Deleuze/Bazin lists in the book's order with a 2-line explainer before each film (what to notice), and a short AI discussion afterwards.
  - User-made lists that the family can share and subscribe to; import a Letterboxd/Kinopoisk list by URL.
  - More sources worth adding: Criterion Closet picks, Pauline Kael's «5001 Nights» (selection), Kinopoisk «250 лучших» snapshot each New Year, «Золотой орёл»/Венеция/Берлинале winners, BFI TV 100 for series.
- **Awards as filters.** «Обзор → Оскар-лауреаты не просмотренные», «Каннские победители 2000-х», award badges in search results; «на этой неделе церемония — номинанты в доступе».
- **"Because you finished X" for series**: when a series ends, a card with 3 shows of the same creator/tone, with how many seasons and minutes they take.
- **New-season alerts** that matter: notify only for series someone finished or is mid-way in, with «серия вышла, раздача 1080p готова» once a good release exists, not when TMDB announces it.

## 3. The TV experience

- ★ **Voice search from the phone.** Hold a mic button in the remote screen → speech-to-text on the phone → results appear on the TV. Typing on TV keyboards is the worst part of every TV app.
- **Instant resume of the whole household state.** When the TV turns on, Home opens on «Продолжить» of whoever watched last on this TV, with profile switch one button away.
- **Picture-in-picture info while watching**: ↑ shows cast with photos, ↓ shows "who is this actor" for the current scene (from TMDB cast + timestamp), awards, trivia from Wikidata.
- **Ambient mode**: when idle, show slow backdrops of films from the watchlist with a quote/fact, plus the clock and weather — turns the TV into something pleasant, not a screensaver.
- **Kids profile done properly**: PIN on exit, age rating limits per profile (TMDB certifications), daily time limit with a friendly mascot «пора спать» screen, only pre-approved YouTube channels.
- **Remote-less fallback**: if MSX loses focus or the remote dies, the phone remote's d-pad can drive TV navigation (already have the channel) — expose full arrow/OK/back pad on the phone.

## 4. Phone and web

- **Offline downloads for trips**: transcode to a phone-friendly 720p MP4 on the server, download to the iPad/phone PWA storage, sync progress back when online.
- **«Смотрим вместе» on two devices**: synced playback between TV and a phone in another city (watch party) with a small chat/emoji overlay.
- **Share card**: a nice image card «Марти рекомендует» with poster, rating, one-line why — to send in Telegram to friends.
- **Widgets/shortcuts**: iOS/Android home-screen shortcuts «Продолжить на ТВ», «Пульт».

## 5. Family and personal

- ★ **Weekly family digest** (Sunday evening, in-app + optional Telegram): what each person watched, the top-rated film of the week, one pick for next week everyone hasn't seen, unfinished series reminders.
- **Taste DNA that explains itself**: «вы любите медленное кино 60-х и азиатские триллеры; вам почти никогда не нравятся комедии после 2010» — editable, so wrong inferences can be removed.
- **Diary/letterboxd-style log**: date, rating, one-line note, re-watches; export to CSV/Letterboxd.
- **Year in review** (December): minutes watched, top directors/countries/decades, longest binge, a poster collage — shareable.

## 6. Reliability and operations

- ★ **One "health" page for the household admin**: VPN, TMDB, Prowlarr indexers, TorrServer, transcoder load, disk, Invidious, Wikidata backfills, last errors from TVs — red/green with the fix suggestion next to each. Most outages so far (TMDB via VPN, YouTube companion, Byparr zombies) would have been one glance.
- **Telegram alerts** for real problems only (VPN down > 10 min, disk > 90 %, TorrServer unreachable, repeated TV decode errors).
- **Automatic Prowlarr indexer health**: disable an indexer that fails for a day, re-enable when it recovers; show which trackers actually produced the releases you played.
- **Backups**: nightly Postgres dump (profiles, history, ratings, lists) to a second location; one-command restore tested monthly.
- **TorrServer hygiene**: cap total cache use across simultaneous streams; clean up torrents Cineko added after N days (never Lampa's).
- **Performance budget in CI**: fail the build if TV Home's first render or scroll frame time regresses on a throttled-CPU profile (Tizen is slow); same for the PWA scroll test that caught the fixed-background issue.

## 7. Smaller polish that people notice

- Remember the audio track and subtitle choice per series, not just per release.
- «Без спойлеров» mode for series: hide episode titles/descriptions/thumbnails beyond the next unwatched one.
- Show runtime as «закончится в 23:40» on every card and in the player.
- Long-press on a card (TV OK-hold / phone long-tap) → quick menu: в «Буду смотреть», уже видел, не предлагать, на ТВ.
- Night mode for audio: dynamic range compression in the compat stream (quiet explosions, clear dialogue) as a player toggle.
- Translate film descriptions missing in Russian with AI (TMDB often lacks RU overviews for older films).

---

### Suggested order

1. Release pre-check + learning from outcomes (§1) — biggest reduction in "it didn't play".
2. Group pick + time-aware suggestions (§2) — the nightly «что посмотрим» moment.
3. Voice search from the phone (§3).
4. Health page + Telegram alerts + backups (§6).
5. Weekly digest and «Подборки» achievements/course mode (§5, §2).
