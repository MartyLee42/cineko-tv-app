package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/integrations/tmdb"
)

const maxCast = 30

// Detail returns full details for a stored title. The first request per
// language loads them from TMDB synchronously; afterwards they are served
// from the database and refreshed in the background once older than
// detailMaxAge.
func (s *Service) Detail(ctx context.Context, id, lang string) (*MediaDetail, error) {
	ref, err := s.refLang(ctx, id, lang)
	if err != nil {
		return nil, err
	}
	switch {
	case ref.fetchedAt == nil:
		if err := s.loadDetail(ctx, ref, lang); err != nil {
			if errors.Is(err, tmdb.ErrNotFound) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	case time.Since(*ref.fetchedAt) > detailMaxAge:
		s.background("detail", func(ctx context.Context) error { return s.loadDetail(ctx, ref, lang) })
	}
	return s.readDetail(ctx, id, lang)
}

// background runs a refresh detached from the request, with its own timeout.
func (s *Service) background(what string, fn func(context.Context) error) {
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := fn(ctx); err != nil {
			s.log.Warn("background refresh failed", "what", what, "err", err)
		}
	}()
}

// WaitBackground blocks until in-flight background refreshes finish.
func (s *Service) WaitBackground() { s.bg.Wait() }

func (s *Service) loadDetail(ctx context.Context, ref *mediaRef, lang string) error {
	_, err, _ := s.refresh.Do("detail:"+ref.id+":"+lang, func() (any, error) {
		rec, err := s.fetchDetail(ctx, ref.kind, ref.tmdbID, lang)
		if err != nil {
			return nil, err
		}
		return nil, s.saveDetail(ctx, lang, rec)
	})
	return err
}

// videoLanguages asks TMDB for trailers in the requested language plus
// English (and language-less uploads) so we can fall back.
func videoLanguages(lang string) string {
	if lang == "en" {
		return "en,null"
	}
	return lang + ",en,null"
}

// detailRecord is a normalized movie or series, ready to persist.
type detailRecord struct {
	kind                       string
	tmdbID                     int
	originalTitle, originalLng string
	status                     string
	releaseDate, lastAirDate   *string
	year                       *int
	runtime                    *int
	numSeasons, numEpisodes    *int
	poster, backdrop           *string
	voteAverage, popularity    float64
	voteCount                  int
	countries                  []string
	genres                     []tmdb.Genre
	imdb                       *string
	tvdb                       *int
	tr                         translation
	cast, crew                 []credit
	seasons                    []tmdb.SeasonSummary
	// keywords is nil when TMDB didn't append them (kept as stored).
	keywords []tmdb.Keyword
}

type credit struct {
	tmdbID      int
	name, local string // original and localized name
	profile     *string
	character   string
	job, dept   string
	order       int
}

func (s *Service) fetchDetail(ctx context.Context, kind string, tmdbID int, lang string) (*detailRecord, error) {
	q := url.Values{
		"language":               {tmdb.Language(lang)},
		"include_video_language": {videoLanguages(lang)},
	}
	path := fmt.Sprintf("/%s/%d", tmdb.MediaType(kind), tmdbID)
	if kind == "series" {
		// aggregate_credits: series-wide cast (plain credits = latest season only).
		q.Set("append_to_response", "aggregate_credits,external_ids,videos,keywords")
	} else {
		q.Set("append_to_response", "credits,external_ids,videos,keywords")
	}
	body, err := s.tmdb.Get(ctx, path, q)
	if err != nil {
		if errors.Is(err, tmdb.ErrNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	if kind == "series" {
		var tv tmdb.TV
		if err := json.Unmarshal(body, &tv); err != nil {
			return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
		}
		return fromTV(&tv, lang), nil
	}
	var m tmdb.Movie
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	return fromMovie(&m, lang), nil
}

var movieCrewJobs = []string{"Director", "Screenplay", "Writer", "Original Music Composer", "Director of Photography"}

func fromMovie(m *tmdb.Movie, lang string) *detailRecord {
	r := &detailRecord{
		kind: "movie", tmdbID: m.ID, originalTitle: m.OriginalTitle, originalLng: m.OriginalLanguage,
		status: m.Status, runtime: positive(m.Runtime),
		poster: emptyNil(m.PosterPath), backdrop: emptyNil(m.BackdropPath),
		voteAverage: m.VoteAverage, voteCount: m.VoteCount, popularity: m.Popularity,
		genres: m.Genres, imdb: emptyNil(m.ExternalIDs.IMDbID),
	}
	r.releaseDate, r.year = parseDate(m.ReleaseDate)
	r.countries = m.OriginCountry
	if len(r.countries) == 0 {
		for _, c := range m.ProductionCountries {
			r.countries = append(r.countries, c.ISO)
		}
	}
	r.tr = translation{Title: orDefault(m.Title, m.OriginalTitle), Overview: m.Overview, Tagline: m.Tagline,
		PosterPath: r.poster, BackdropPath: r.backdrop, Trailer: pickTrailer(m.Videos.Results, lang)}
	if m.Keywords != nil {
		r.keywords = nonNil(m.Keywords.All())
	}

	cast := slices.Clone(m.Credits.Cast)
	slices.SortStableFunc(cast, func(a, b tmdb.CastCredit) int { return a.Order - b.Order })
	for _, c := range cast {
		if len(r.cast) == maxCast {
			break
		}
		r.cast = append(r.cast, credit{tmdbID: c.ID, name: orDefault(c.OriginalName, c.Name), local: c.Name,
			profile: emptyNil(c.ProfilePath), character: c.Character, order: len(r.cast)})
	}
	// Key crew only, grouped by job importance, each (person, job) once.
	for _, job := range movieCrewJobs {
		for _, c := range m.Credits.Crew {
			if c.Job == job && !hasCredit(r.crew, c.ID, job) {
				r.crew = append(r.crew, credit{tmdbID: c.ID, name: orDefault(c.OriginalName, c.Name), local: c.Name,
					profile: emptyNil(c.ProfilePath), job: c.Job, dept: c.Department, order: len(r.crew)})
			}
		}
	}
	return r
}

func fromTV(t *tmdb.TV, lang string) *detailRecord {
	r := &detailRecord{
		kind: "series", tmdbID: t.ID, originalTitle: t.OriginalName, originalLng: t.OriginalLanguage,
		status: t.Status, poster: emptyNil(t.PosterPath), backdrop: emptyNil(t.BackdropPath),
		voteAverage: t.VoteAverage, voteCount: t.VoteCount, popularity: t.Popularity,
		genres: t.Genres, countries: t.OriginCountry,
		numSeasons: t.NumberOfSeasons, numEpisodes: t.NumberOfEpisodes,
		imdb: emptyNil(t.ExternalIDs.IMDbID), tvdb: t.ExternalIDs.TVDBID, seasons: t.Seasons,
	}
	r.releaseDate, r.year = parseDate(t.FirstAirDate)
	if t.LastAirDate != nil {
		r.lastAirDate, _ = parseDate(*t.LastAirDate)
	}
	// episode_run_time is often empty nowadays; fall back to the last episode.
	if len(t.EpisodeRunTime) > 0 {
		r.runtime = positive(&t.EpisodeRunTime[0])
	} else if t.LastEpisodeToAir != nil {
		r.runtime = positive(t.LastEpisodeToAir.Runtime)
	}
	r.tr = translation{Title: orDefault(t.Name, t.OriginalName), Overview: t.Overview, Tagline: t.Tagline,
		PosterPath: r.poster, BackdropPath: r.backdrop, Trailer: pickTrailer(t.Videos.Results, lang)}
	if t.Keywords != nil {
		r.keywords = nonNil(t.Keywords.All())
	}

	cast := slices.Clone(t.AggregateCredits.Cast)
	slices.SortStableFunc(cast, func(a, b tmdb.AggregateCast) int { return a.Order - b.Order })
	for _, c := range cast {
		if len(r.cast) == maxCast {
			break
		}
		// The role with the most episodes is the one people know them for.
		character, best := "", -1
		for _, role := range c.Roles {
			if role.EpisodeCount > best {
				character, best = role.Character, role.EpisodeCount
			}
		}
		r.cast = append(r.cast, credit{tmdbID: c.ID, name: orDefault(c.OriginalName, c.Name), local: c.Name,
			profile: emptyNil(c.ProfilePath), character: character, order: len(r.cast)})
	}
	// Series crew: creators, then the main composer(s). Per-episode directors
	// and writers are too many to be useful on a details page.
	for _, c := range t.CreatedBy {
		if !hasCredit(r.crew, c.ID, "Creator") {
			r.crew = append(r.crew, credit{tmdbID: c.ID, name: orDefault(c.OriginalName, c.Name), local: c.Name,
				profile: emptyNil(c.ProfilePath), job: "Creator", dept: "Writing", order: len(r.crew)})
		}
	}
	composers := 0
	for _, c := range t.AggregateCredits.Crew {
		for _, j := range c.Jobs {
			if j.Job == "Original Music Composer" && composers < 2 && !hasCredit(r.crew, c.ID, j.Job) {
				composers++
				r.crew = append(r.crew, credit{tmdbID: c.ID, name: orDefault(c.OriginalName, c.Name), local: c.Name,
					profile: emptyNil(c.ProfilePath), job: j.Job, dept: c.Department, order: len(r.crew)})
			}
		}
	}
	return r
}

// pickTrailer returns the best YouTube trailer: requested language first,
// then English; Trailer before Teaser; official before fan uploads.
func pickTrailer(videos []tmdb.Video, lang string) *Video {
	var best *tmdb.Video
	bestScore := 1 << 30
	for i := range videos {
		v := &videos[i]
		if v.Site != "YouTube" || v.Key == "" {
			continue
		}
		var score int
		switch v.Lang {
		case lang:
		case "en":
			score += 100
		default:
			continue
		}
		switch v.Type {
		case "Trailer":
		case "Teaser":
			score += 10
		default:
			continue
		}
		if !v.Official {
			score++
		}
		if score < bestScore {
			best, bestScore = v, score
		}
	}
	if best == nil {
		return nil
	}
	return &Video{Site: best.Site, Key: best.Key, Name: best.Name, Type: best.Type}
}

func hasCredit(cs []credit, id int, job string) bool {
	return slices.ContainsFunc(cs, func(c credit) bool { return c.tmdbID == id && c.job == job })
}

// saveDetail persists a detail record in one transaction.
func (s *Service) saveDetail(ctx context.Context, lang string, r *detailRecord) error {
	tr, _ := json.Marshal(r.tr)
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var mediaID string
		// The language's translation is replaced (not merged) so a trailer
		// that disappeared upstream disappears here too.
		err := tx.QueryRow(ctx, `
			INSERT INTO media AS m (kind, tmdb_id, original_title, original_language, release_date, year, runtime, status,
			                       poster_path, backdrop_path, vote_average, vote_count, popularity,
			                       number_of_seasons, number_of_episodes, last_air_date, countries,
			                       translations, details_fetched_at)
			VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::date, $17,
			        jsonb_build_object($18::text, $19::jsonb), jsonb_build_object($18::text, now()))
			ON CONFLICT (kind, tmdb_id) DO UPDATE SET
				original_title = EXCLUDED.original_title, original_language = EXCLUDED.original_language,
				release_date = EXCLUDED.release_date, year = EXCLUDED.year, runtime = EXCLUDED.runtime,
				status = EXCLUDED.status,
				poster_path   = CASE WHEN $18::text = 'en' OR m.poster_path IS NULL THEN EXCLUDED.poster_path ELSE m.poster_path END,
				backdrop_path = CASE WHEN $18::text = 'en' OR m.backdrop_path IS NULL THEN EXCLUDED.backdrop_path ELSE m.backdrop_path END,
				vote_average = EXCLUDED.vote_average, vote_count = EXCLUDED.vote_count, popularity = EXCLUDED.popularity,
				number_of_seasons = EXCLUDED.number_of_seasons, number_of_episodes = EXCLUDED.number_of_episodes,
				last_air_date = EXCLUDED.last_air_date, countries = EXCLUDED.countries,
				translations = m.translations || EXCLUDED.translations,
				details_fetched_at = m.details_fetched_at || EXCLUDED.details_fetched_at,
				updated_at = now()
			RETURNING id`,
			r.kind, r.tmdbID, r.originalTitle, r.originalLng, r.releaseDate, r.year, r.runtime, r.status,
			r.poster, r.backdrop, r.voteAverage, r.voteCount, r.popularity,
			r.numSeasons, r.numEpisodes, r.lastAirDate, nonNil(r.countries), lang, string(tr)).Scan(&mediaID)
		if err != nil {
			return err
		}

		// External ids. imdb/tvdb are replaced; a duplicate claimed by another
		// TMDB entry (TMDB has a few) is skipped rather than failing.
		tmdbProvider := "tmdb_movie"
		if r.kind == "series" {
			tmdbProvider = "tmdb_tv"
		}
		var tvdb *string
		if r.tvdb != nil && *r.tvdb > 0 {
			v := strconv.Itoa(*r.tvdb)
			tvdb = &v
		}
		if _, err := tx.Exec(ctx, `DELETE FROM media_external_ids WHERE media_id = $1 AND provider IN ('imdb', 'tvdb')`, mediaID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO media_external_ids (media_id, provider, external_id)
			SELECT $1, p, e FROM (VALUES ($2::text, $3::text), ('imdb', $4::text), ('tvdb', $5::text)) AS v(p, e)
			WHERE e IS NOT NULL
			ON CONFLICT DO NOTHING`, mediaID, tmdbProvider, strconv.Itoa(r.tmdbID), r.imdb, tvdb); err != nil {
			return err
		}

		// Genres (names for this language + the title's ordered list).
		if err := s.upsertGenres(ctx, tx, lang, r.genres); err != nil {
			return err
		}
		gIDs := make([]int32, len(r.genres))
		for i, g := range r.genres {
			gIDs[i] = int32(g.ID)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM media_genres WHERE media_id = $1`, mediaID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO media_genres (media_id, genre_id, position)
			SELECT $1, g, (ord - 1)::smallint FROM unnest($2::int[]) WITH ORDINALITY AS t(g, ord)
			ON CONFLICT DO NOTHING`, mediaID, gIDs); err != nil {
			return err
		}

		if err := saveCredits(ctx, tx, mediaID, lang, r); err != nil {
			return err
		}
		if r.keywords != nil {
			if err := saveKeywords(ctx, tx, mediaID, r.keywords); err != nil {
				return err
			}
		}
		return saveSeasonSummaries(ctx, tx, mediaID, lang, r.seasons)
	})
}

func saveCredits(ctx context.Context, tx pgx.Tx, mediaID, lang string, r *detailRecord) error {
	if _, err := tx.Exec(ctx, `DELETE FROM media_cast WHERE media_id = $1`, mediaID); err != nil {
		return err
	}
	all := append(slices.Clone(r.cast), r.crew...)
	if len(all) == 0 {
		return nil
	}
	// People, deduped and sorted (consistent lock order across concurrent saves).
	people := map[int]credit{}
	for _, c := range all {
		people[c.tmdbID] = c
	}
	pids := make([]int, 0, len(people))
	for id := range people {
		pids = append(pids, id)
	}
	slices.Sort(pids)
	var (
		ids           = make([]int32, len(pids))
		names, locals = make([]string, len(pids)), make([]string, len(pids))
		profiles      = make([]*string, len(pids))
	)
	for i, id := range pids {
		p := people[id]
		ids[i], names[i], locals[i], profiles[i] = int32(id), p.name, p.local, p.profile
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO media_people AS p (tmdb_id, name, translations, profile_path)
		SELECT id, name, jsonb_build_object($5::text, local), profile
		FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]) AS t(id, name, local, profile)
		ON CONFLICT (tmdb_id) DO UPDATE SET
			name = EXCLUDED.name, profile_path = EXCLUDED.profile_path,
			translations = p.translations || EXCLUDED.translations, updated_at = now()
		RETURNING id, tmdb_id`, ids, names, locals, profiles, lang)
	if err != nil {
		return err
	}
	personID := map[int]string{}
	for rows.Next() {
		var id string
		var tid int
		if err := rows.Scan(&id, &tid); err != nil {
			rows.Close()
			return err
		}
		personID[tid] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	var (
		pIDs, types, chars, jobs, depts []string
		ords                            []int32
	)
	add := func(typ string, c credit) {
		pIDs, types, chars = append(pIDs, personID[c.tmdbID]), append(types, typ), append(chars, c.character)
		jobs, depts, ords = append(jobs, c.job), append(depts, c.dept), append(ords, int32(c.order))
	}
	for _, c := range r.cast {
		add("cast", c)
	}
	for _, c := range r.crew {
		add("crew", c)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO media_cast (media_id, person_id, credit_type, character, job, department, ord)
		SELECT $1, pid::uuid, typ, ch, job, dept, ord
		FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[]) AS t(pid, typ, ch, job, dept, ord)
		ON CONFLICT DO NOTHING`, mediaID, pIDs, types, chars, jobs, depts, ords)
	return err
}

func saveSeasonSummaries(ctx context.Context, tx pgx.Tx, mediaID, lang string, seasons []tmdb.SeasonSummary) error {
	if len(seasons) == 0 {
		return nil
	}
	n := len(seasons)
	nums, tids, counts := make([]int32, n), make([]int32, n), make([]int32, n)
	dates, posters := make([]*string, n), make([]*string, n)
	trs := make([]string, n)
	for i, se := range seasons {
		nums[i], tids[i], counts[i] = int32(se.SeasonNumber), int32(se.ID), int32(se.EpisodeCount)
		if se.AirDate != nil {
			dates[i], _ = parseDate(*se.AirDate)
		}
		posters[i] = emptyNil(se.PosterPath)
		b, _ := json.Marshal(nameTranslation{Name: se.Name, Overview: se.Overview, PosterPath: posters[i]})
		trs[i] = string(b)
	}
	// Seasons are never deleted here: episodes (and later watch history)
	// hang off them.
	_, err := tx.Exec(ctx, `
		INSERT INTO seasons AS s (media_id, season_number, tmdb_id, air_date, episode_count, poster_path, translations)
		SELECT $1, n, tid, d::date, cnt, pp, jsonb_build_object($8::text, tr::jsonb)
		FROM unnest($2::int[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[]) AS t(n, tid, d, cnt, pp, tr)
		ON CONFLICT (media_id, season_number) DO UPDATE SET
			tmdb_id = EXCLUDED.tmdb_id, air_date = EXCLUDED.air_date, episode_count = EXCLUDED.episode_count,
			poster_path = CASE WHEN $8::text = 'en' OR s.poster_path IS NULL THEN EXCLUDED.poster_path ELSE s.poster_path END,
			translations = s.translations || EXCLUDED.translations, updated_at = now()`,
		mediaID, nums, tids, dates, counts, posters, trs, lang)
	return err
}

// readDetail assembles a MediaDetail for one language from the database,
// falling back to English text where a translation is missing.
func (s *Service) readDetail(ctx context.Context, id, lang string) (*MediaDetail, error) {
	var (
		d                MediaDetail
		release, lastAir *time.Time
		trs              map[string]translation
		poster, backdrop *string
		voteAvg          float64
	)
	err := s.pool.QueryRow(ctx, `
		SELECT kind, tmdb_id, original_title, original_language, release_date, year, runtime, status,
		       poster_path, backdrop_path, vote_average, vote_count, number_of_seasons, number_of_episodes,
		       last_air_date, countries, translations
		FROM media WHERE id = $1`, id).Scan(
		&d.Kind, &d.TMDBID, &d.OriginalTitle, &d.OriginalLanguage, &release, &d.Year, &d.Runtime, &d.Status,
		&poster, &backdrop, &voteAvg, &d.VoteCount, &d.NumberOfSeasons, &d.NumberOfEpisodes,
		&lastAir, &d.Countries, &trs)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	d.ID = id
	d.ReleaseDate, d.LastAirDate = fmtDate(release), fmtDate(lastAir)
	d.Rating = rating(voteAvg, d.VoteCount)
	t, en := trs[lang], trs["en"]
	d.Title = firstNonEmpty(t.Title, en.Title, d.OriginalTitle)
	d.Overview = firstNonEmpty(t.Overview, en.Overview)
	d.Tagline = firstNonEmpty(t.Tagline, en.Tagline)
	d.PosterPath = firstNonNil(t.PosterPath, poster)
	d.BackdropPath = firstNonNil(t.BackdropPath, backdrop)
	d.Trailer = t.Trailer
	d.Countries = nonNil(d.Countries)
	d.ExternalIDs.TMDB = d.TMDBID

	rows, err := s.pool.Query(ctx, `SELECT provider, external_id FROM media_external_ids WHERE media_id = $1`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p, e string
		if err := rows.Scan(&p, &e); err != nil {
			rows.Close()
			return nil, err
		}
		switch p {
		case "imdb":
			d.ExternalIDs.IMDb = &e
		case "tvdb":
			if n, err := strconv.Atoi(e); err == nil {
				d.ExternalIDs.TVDB = &n
			}
		case "kinopoisk":
			if n, err := strconv.Atoi(e); err == nil {
				d.ExternalIDs.Kinopoisk = &n
			}
		}
	}
	rows.Close()

	d.Genres, d.GenreIDs = []Genre{}, []int{}
	rows, err = s.pool.Query(ctx, `
		SELECT mg.genre_id, COALESCE(g.translations ->> $2::text, g.translations ->> 'en', '')
		FROM media_genres mg LEFT JOIN genres g ON g.id = mg.genre_id
		WHERE mg.media_id = $1 ORDER BY mg.position, mg.genre_id`, id, lang)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var g Genre
		if err := rows.Scan(&g.ID, &g.Name); err != nil {
			rows.Close()
			return nil, err
		}
		d.Genres = append(d.Genres, g)
		d.GenreIDs = append(d.GenreIDs, g.ID)
	}
	rows.Close()

	d.Cast, d.Crew, d.Awards = []CastMember{}, []CrewMember{}, []AwardGroup{}
	rows, err = s.pool.Query(ctx, `
		SELECT c.credit_type, p.tmdb_id, COALESCE(NULLIF(p.translations ->> $2::text, ''), p.name),
		       c.character, c.job, c.department, p.profile_path, c.ord
		FROM media_cast c JOIN media_people p ON p.id = c.person_id
		WHERE c.media_id = $1 ORDER BY c.credit_type, c.ord`, id, lang)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var typ, name, char, job, dept string
		var pid, ord int
		var profile *string
		if err := rows.Scan(&typ, &pid, &name, &char, &job, &dept, &profile, &ord); err != nil {
			rows.Close()
			return nil, err
		}
		if typ == "cast" {
			d.Cast = append(d.Cast, CastMember{PersonTMDBID: pid, Name: name, Character: char, ProfilePath: profile, Order: ord})
		} else {
			d.Crew = append(d.Crew, CrewMember{PersonTMDBID: pid, Name: name, Job: job, Department: dept, ProfilePath: profile})
		}
	}
	rows.Close()

	d.Seasons = []SeasonSummary{}
	if d.Kind == "series" {
		rows, err = s.pool.Query(ctx, `
			SELECT season_number, air_date, episode_count, poster_path, translations
			FROM seasons WHERE media_id = $1 ORDER BY season_number`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			ss, err := scanSeasonSummary(rows, lang)
			if err != nil {
				rows.Close()
				return nil, err
			}
			d.Seasons = append(d.Seasons, *ss)
		}
		rows.Close()
	}
	return &d, rows.Err()
}

func scanSeasonSummary(row pgx.Row, lang string) (*SeasonSummary, error) {
	var (
		ss     SeasonSummary
		air    *time.Time
		poster *string
		trs    map[string]nameTranslation
	)
	if err := row.Scan(&ss.SeasonNumber, &air, &ss.EpisodeCount, &poster, &trs); err != nil {
		return nil, err
	}
	t, en := trs[lang], trs["en"]
	ss.Name = firstNonEmpty(t.Name, en.Name)
	ss.Overview = firstNonEmpty(t.Overview, en.Overview)
	ss.AirDate = fmtDate(air)
	ss.PosterPath = firstNonNil(t.PosterPath, poster)
	return &ss, nil
}

// ---- seasons ----

// Season returns a series season with episodes. Movies and unknown seasons
// are 404. Same freshness policy as details.
func (s *Service) Season(ctx context.Context, id string, number int, lang string) (*Season, error) {
	ref, err := s.ref(ctx, id)
	if err != nil {
		return nil, err
	}
	if ref.kind != "series" {
		return nil, ErrNotFound
	}
	var fetchedAt *time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT (episodes_fetched_at ->> $3::text)::timestamptz FROM seasons WHERE media_id = $1 AND season_number = $2`,
		id, number, lang).Scan(&fetchedAt)
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	switch {
	case fetchedAt == nil:
		if err := s.loadSeason(ctx, ref, number, lang); err != nil {
			if errors.Is(err, tmdb.ErrNotFound) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	case time.Since(*fetchedAt) > detailMaxAge:
		s.background("season", func(ctx context.Context) error { return s.loadSeason(ctx, ref, number, lang) })
	}
	return s.readSeason(ctx, id, number, lang)
}

func (s *Service) loadSeason(ctx context.Context, ref *mediaRef, number int, lang string) error {
	_, err, _ := s.refresh.Do(fmt.Sprintf("season:%s:%d:%s", ref.id, number, lang), func() (any, error) {
		body, err := s.tmdb.Get(ctx, fmt.Sprintf("/tv/%d/season/%d", ref.tmdbID, number), url.Values{"language": {tmdb.Language(lang)}})
		if err != nil {
			if errors.Is(err, tmdb.ErrNotFound) {
				return nil, err
			}
			return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
		}
		var se tmdb.Season
		if err := json.Unmarshal(body, &se); err != nil {
			return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
		}
		return nil, s.saveSeason(ctx, ref.id, number, lang, &se)
	})
	return err
}

func (s *Service) saveSeason(ctx context.Context, mediaID string, number int, lang string, se *tmdb.Season) error {
	var air *string
	if se.AirDate != nil {
		air, _ = parseDate(*se.AirDate)
	}
	poster := emptyNil(se.PosterPath)
	tr, _ := json.Marshal(nameTranslation{Name: se.Name, Overview: se.Overview, PosterPath: poster})
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var seasonID string
		err := tx.QueryRow(ctx, `
			INSERT INTO seasons AS s (media_id, season_number, tmdb_id, air_date, episode_count, poster_path,
			                          translations, episodes_fetched_at)
			VALUES ($1, $2, $3, $4::date, $5, $6, jsonb_build_object($7::text, $8::jsonb), jsonb_build_object($7::text, now()))
			ON CONFLICT (media_id, season_number) DO UPDATE SET
				tmdb_id = EXCLUDED.tmdb_id, air_date = EXCLUDED.air_date, episode_count = EXCLUDED.episode_count,
				poster_path = CASE WHEN $7::text = 'en' OR s.poster_path IS NULL THEN EXCLUDED.poster_path ELSE s.poster_path END,
				translations = s.translations || EXCLUDED.translations,
				episodes_fetched_at = s.episodes_fetched_at || EXCLUDED.episodes_fetched_at,
				updated_at = now()
			RETURNING id`,
			mediaID, number, se.ID, air, len(se.Episodes), poster, lang, string(tr)).Scan(&seasonID)
		if err != nil {
			return err
		}
		if len(se.Episodes) == 0 {
			return nil
		}
		n := len(se.Episodes)
		nums, tids, runtimes, votes := make([]int32, n), make([]int32, n), make([]*int32, n), make([]int32, n)
		dates, stills, trs := make([]*string, n), make([]*string, n), make([]string, n)
		avgs := make([]float64, n)
		for i, e := range se.Episodes {
			nums[i], tids[i], votes[i], avgs[i] = int32(e.EpisodeNumber), int32(e.ID), int32(e.VoteCount), e.VoteAverage
			if rt := positive(e.Runtime); rt != nil {
				v := int32(*rt)
				runtimes[i] = &v
			}
			if e.AirDate != nil {
				dates[i], _ = parseDate(*e.AirDate)
			}
			stills[i] = emptyNil(e.StillPath)
			b, _ := json.Marshal(nameTranslation{Name: e.Name, Overview: e.Overview})
			trs[i] = string(b)
		}
		// (media, season, episode) is the stable key: re-fetches keep ids.
		_, err = tx.Exec(ctx, `
			INSERT INTO episodes AS e (media_id, season_id, season_number, episode_number, tmdb_id, air_date, runtime,
			                           still_path, vote_average, vote_count, translations)
			SELECT $1, $2, $3, n, tid, d::date, rt, st, va, vc, jsonb_build_object($4::text, tr::jsonb)
			FROM unnest($5::int[], $6::int[], $7::text[], $8::int[], $9::text[], $10::float8[], $11::int[], $12::text[])
			     AS t(n, tid, d, rt, st, va, vc, tr)
			ON CONFLICT (media_id, season_number, episode_number) DO UPDATE SET
				season_id = EXCLUDED.season_id, tmdb_id = EXCLUDED.tmdb_id, air_date = EXCLUDED.air_date,
				runtime = EXCLUDED.runtime, still_path = EXCLUDED.still_path,
				vote_average = EXCLUDED.vote_average, vote_count = EXCLUDED.vote_count,
				translations = e.translations || EXCLUDED.translations, updated_at = now()`,
			mediaID, seasonID, number, lang, nums, tids, dates, runtimes, stills, avgs, votes, trs)
		return err
	})
}

func (s *Service) readSeason(ctx context.Context, mediaID string, number int, lang string) (*Season, error) {
	ss, err := scanSeasonSummary(s.pool.QueryRow(ctx, `
		SELECT season_number, air_date, episode_count, poster_path, translations
		FROM seasons WHERE media_id = $1 AND season_number = $2`, mediaID, number), lang)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	out := &Season{SeasonSummary: *ss, MediaID: mediaID, Episodes: []Episode{}}
	rows, err := s.pool.Query(ctx, `
		SELECT id, season_number, episode_number, air_date, runtime, still_path, vote_average, vote_count, translations
		FROM episodes WHERE media_id = $1 AND season_number = $2 ORDER BY episode_number`, mediaID, number)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			e     Episode
			air   *time.Time
			avg   float64
			votes int
			trs   map[string]nameTranslation
		)
		if err := rows.Scan(&e.ID, &e.SeasonNumber, &e.EpisodeNumber, &air, &e.Runtime, &e.StillPath, &avg, &votes, &trs); err != nil {
			return nil, err
		}
		t, en := trs[lang], trs["en"]
		e.Name = firstNonEmpty(t.Name, en.Name)
		e.Overview = firstNonEmpty(t.Overview, en.Overview)
		e.AirDate = fmtDate(air)
		e.Rating = rating(avg, votes)
		out.Episodes = append(out.Episodes, e)
	}
	return out, rows.Err()
}

// ---- small helpers ----

func fmtDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format("2006-01-02")
	return &s
}

func positive(n *int) *int {
	if n == nil || *n <= 0 {
		return nil
	}
	return n
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstNonNil(vals ...*string) *string {
	for _, v := range vals {
		if v != nil && *v != "" {
			return v
		}
	}
	return nil
}

// RefreshSeries reloads a series' details (new seasons, status) and the
// episodes of its latest seasons from TMDB now, whatever their age. Used by
// the nightly new-episodes check (internal/watch/newepisodes.go).
func (s *Service) RefreshSeries(ctx context.Context, id, lang string) error {
	ref, err := s.ref(ctx, id)
	if err != nil {
		return err
	}
	if ref.kind != "series" {
		return ErrNotFound
	}
	if err := s.loadDetail(ctx, ref, lang); err != nil {
		return err
	}
	// The newest two regular seasons: a new season, or new episodes of the
	// running one (and the previous one when a season just rolled over).
	rows, err := s.pool.Query(ctx, `
		SELECT season_number FROM seasons WHERE media_id = $1 AND season_number > 0
		ORDER BY season_number DESC LIMIT 2`, id)
	if err != nil {
		return err
	}
	var nums []int
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		nums = append(nums, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, n := range nums {
		if err := s.loadSeason(ctx, ref, n, lang); err != nil && !errors.Is(err, tmdb.ErrNotFound) {
			return err
		}
	}
	return nil
}
