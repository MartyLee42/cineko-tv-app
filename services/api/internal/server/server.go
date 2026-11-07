// Package server wires the modules into one Fiber app.
package server

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/recover"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/appsettings"
	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/awards"
	"martytv/api/internal/catalog"
	"martytv/api/internal/clientlog"
	"martytv/api/internal/config"
	"martytv/api/internal/curated"
	"martytv/api/internal/devices"
	"martytv/api/internal/downloads"
	"martytv/api/internal/family"
	"martytv/api/internal/foryou"
	"martytv/api/internal/httpx"
	"martytv/api/internal/imports"
	"martytv/api/internal/integrations"
	"martytv/api/internal/integrations/jacred"
	"martytv/api/internal/integrations/tmdb"
	"martytv/api/internal/integrations/torrserver"
	"martytv/api/internal/iptv"
	"martytv/api/internal/ivrestart"
	"martytv/api/internal/messages"
	"martytv/api/internal/pairing"
	"martytv/api/internal/playback"
	"martytv/api/internal/profiles"
	"martytv/api/internal/ratings"
	"martytv/api/internal/realtime"
	"martytv/api/internal/reco"
	"martytv/api/internal/releases"
	"martytv/api/internal/segments"
	"martytv/api/internal/sources"
	"martytv/api/internal/sources/anilibria"
	"martytv/api/internal/sources/cdnvideohub"
	"martytv/api/internal/sources/collaps"
	"martytv/api/internal/sources/sourcesapi"
	"martytv/api/internal/sysmon"
	"martytv/api/internal/trivia"
	"martytv/api/internal/users"
	"martytv/api/internal/video"
	"martytv/api/internal/watch"
)

// Version is set at build time with -ldflags.
var Version = "dev"

type Server struct {
	App     *fiber.App
	Auth    *auth.Service
	Pairing *pairing.Service
	Hub     *realtime.Hub
	Catalog *catalog.Service
	// Playback is exposed so tests can inject a fake release resolver.
	Playback *playback.Service
	Watch    *watch.Service
	// Sysmon backs the admin Server tab; Run samples it every 10 s.
	Sysmon *sysmon.Service
	// Ratings resolves Kinopoisk ids and refreshes KP/IMDb ratings (Run).
	Ratings *ratings.Service
	// Awards fetches film awards/nominations from Wikidata (Run: backfill).
	Awards *awards.Service
	// Sources is the provider registry (Run probes provider health).
	Sources *sources.Registry
	// ClientLog stores client/API errors for the admin Errors tab.
	ClientLog *clientlog.Service
	// Online runs /media/{id}/online lookups and resolves shown variants
	// (sources.VariantLookup) for online playback.
	Online *sourcesapi.Service
	// Imports runs rating imports (Kinopoisk CSV) in the background (Run).
	Imports *imports.Service
	// ForYou: Phase 6 recommendations, AI collections, daily run (Run).
	ForYou *foryou.Service
	// Curated: «Подборки» lists and their resolver (Run: startup + daily).
	Curated *curated.Service
	// Downloads: server downloads + admin storage/TorrServer list (Run).
	Downloads *downloads.Service
	// IPTV: live TV playlists, guide, per-profile channels (Run).
	IPTV *iptv.Service
	// Video: the YouTube «Видео» tab via Invidious (Run: health, feeds).
	Video *video.Service
	// Trivia: «Цитаты» / «Факты» of a title.
	Trivia *trivia.Service
	// InvidiousRestart: the nightly Invidious restart (Run).
	InvidiousRestart *ivrestart.Restarter
}

// New builds the HTTP application.
func New(cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) *Server {
	clientLog := clientlog.NewService(pool, Version, log)
	app := fiber.New(fiber.Config{
		AppName:      "Cineko",
		ErrorHandler: clientLog.WrapErrorHandler(httpx.ErrorHandler(log)), // API 5xx → Errors tab
		BodyLimit:    imports.MaxBodyBytes,
		ReadTimeout:  15 * time.Second,
		IdleTimeout:  120 * time.Second,
		ProxyHeader:  proxyHeader(cfg),
		TrustProxy:   len(cfg.TrustedProxies) > 0,
		TrustProxyConfig: fiber.TrustProxyConfig{
			Proxies: proxyIPs(cfg.TrustedProxies),
		},
		EnableIPValidation: true,
	})

	hasher := auth.NewHasher(cfg.SessionSecret)
	userStore := users.NewStore(pool)
	auditLog := audit.New(pool, log)
	authSvc := auth.NewService(pool, userStore, hasher, cfg.SessionIdleTTL, cfg.SessionAbsoluteTTL)
	mw := auth.NewMiddleware(authSvc, cfg.AllowedOrigins, cfg.CookieSecure)
	deviceStore := devices.NewStore(pool, hasher)
	hub := realtime.NewHub(deviceAccess{s: deviceStore, pool: pool, users: userStore, audit: auditLog}, log)
	authSvc.SetDisconnector(hub)
	clientLog.SetNotifier(hub)
	pairSvc := pairing.NewService(pool, hasher, cfg.PairingTTL)
	tmdbClient := tmdb.New(cfg.TMDB)
	ratingsSvc := ratings.NewFromConfig(cfg.Kinopoisk, pool, tmdbClient, log)
	// Awards & nominations (internal/awards): Wikidata through the ratings
	// client (shared spacing/back-off); badges ride along with the ratings.
	awardsSvc := awards.New(awards.Options{Pool: pool, Wikidata: ratingsSvc.Wikidata(), Log: log})
	ratingsSrc := awardsSvc.WithBadges(ratingsSvc)
	checker := integrations.NewChecker(30*time.Second,
		integrations.NewProwlarr(cfg.Prowlarr),
		integrations.NewTorrServer(cfg.TorrServer),
		integrations.NewTMDB(cfg.TMDB),
		ratingsSvc,
	)
	catalogSvc := catalog.NewService(pool, tmdbClient, cfg.TMDB, cfg.Catalog, log)

	app.Use(recover.New())
	app.Use(httpx.RequestIDMiddleware())
	app.Use(httpx.LoggerMiddleware(log))
	app.Use(imports.LimitOtherBodies()) // BodyLimit fits 5 MB import uploads; 1 MiB for every other route

	app.Get("/healthz", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "version": Version})
	})
	app.Get("/readyz", func(c fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.Context(), 3*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "unavailable", "database": "down"})
		}
		// External services are reported but never fail readiness: the app
		// is usable (accounts, pairing) while they are down.
		deps := map[string]bool{}
		for _, s := range checker.Statuses(ctx) {
			deps[s.Name] = s.OK
		}
		return c.JSON(fiber.Map{"status": "ok", "database": "up", "integrations": deps})
	})

	registerMSX(app, cfg)

	api := app.Group("/api/v1", httpx.SecurityHeaders(), mw.Authenticate(), mw.CSRF())

	api.Get("/ws", realtime.NewHandler(hub, authSvc, cfg.AllowedOrigins).Upgrade())

	auth.NewHandlers(authSvc, mw, userStore, auditLog, cfg.LoginIPLimit).Routes(api)
	profileStore := profiles.NewStore(pool)
	profileHandlers := profiles.NewHandlers(profileStore, auditLog)
	profileHandlers.Routes(api)
	deviceHandlers := devices.NewHandlers(deviceStore, hasher, hub, auditLog)
	deviceHandlers.Routes(api)
	pairHandlers := pairing.NewHandlers(pairSvc, auditLog, hub, cfg.PublicBaseURL.String())
	pairHandlers.Routes(api)

	// Phase 5: watch sync, lists, ratings. Registered BEFORE the catalog and
	// playback routes: their group middleware (/media needs TMDB, /playback
	// needs a principal) would otherwise run first for /media/:id/progress,
	// /media/:id/watched and the sendBeacon progress endpoint.
	watchSvc := watch.NewService(pool, profileStore, catalogSvc, cfg.SessionSecret, log)
	watchSvc.SetNewEpisodes(cfg.NewEpisodes) // nightly «Новые серии» (main: Watch.RunNewEpisodes)
	watchHandlers := watch.NewHandlers(watchSvc)
	watchHandlers.Routes(api)
	msgHandlers := messages.NewHandlers(pool, hub, auditLog)
	msgHandlers.Routes(api)
	reco.NewHandlers(pool, catalogSvc, watchSvc, hub, auditLog).Routes(api)
	importSvc := imports.NewService(pool, catalogSvc, auditLog, log)
	imports.NewHandlers(importSvc, profileStore).Routes(api)
	// Phase 6: personal recommendations («Для вас»), Surprise Me, Explore,
	// AI collections, diary/taste DNA (internal/foryou; not /recommendations).
	// «Семья советует» (internal/family): opt-in sharing between profiles;
	// its row is embedded in /foryou/rows.
	familySvc := family.NewService(family.Deps{Pool: pool, Catalog: catalogSvc, Personal: watchSvc, Profiles: profileStore,
		Ratings: ratingsSrc, Log: log})
	familySvc.Routes(api)
	// «Подборки» (internal/curated): lists from books, directors, polls.
	curatedSvc := curated.NewService(curated.Deps{Pool: pool, Catalog: catalogSvc, Personal: watchSvc, Profiles: profileStore,
		Ratings: ratingsSrc, Log: log})
	curatedSvc.Routes(api)
	appSettings := appsettings.NewStore(pool, auditLog, log) // global switches: /admin/appearance, /status seasonal_effects, AI temperatures
	forYouSvc := foryou.NewService(foryou.Deps{Pool: pool, Catalog: catalogSvc, Personal: watchSvc, Profiles: profileStore,
		Ratings: ratingsSrc, Hub: hub, Family: familySvc, Curated: curatedSvc, Audit: auditLog, Config: cfg.ForYou, Log: log, Settings: appSettings})
	forYouSvc.Routes(api)
	// «Цитаты» / «Факты» (internal/trivia): Wikiquote, Kinopoisk facts, DeepSeek stand-ins.
	triviaSvc := trivia.New(trivia.Options{Pool: pool, KP: ratingsSvc, AI: forYouSvc, Log: log})
	triviaSvc.Routes(api)
	profileHandlers.OnSettingsChanged(forYouSvc.SettingsChanged)

	catalogHandlers := catalog.NewHandlers(catalogSvc, catalog.NewImageProxy(cfg.TMDB, cfg.Catalog.ImageCacheDir, log))
	catalogHandlers.SetPersonalizer(watchSvc)
	catalogHandlers.SetRatings(ratingsSrc)
	catalogHandlers.SetAwards(awardsSvc)
	catalogHandlers.Routes(api)

	// Sources: one registry for every torrent/online/anime provider
	// (docs/architecture.md "Sources"). Built before releases/playback.
	srcReg := sources.NewRegistry(pool, cfg.SessionSecret, log)
	// ---- sources: register providers (one line each; order = UI order) ----
	// Torrent providers feed /media/{id}/releases; online/anime providers
	// feed /media/{id}/online. A provider package exposes a constructor
	// returning a sources.Provider (nil = skip) and is added here, e.g.:
	//   srcReg.Register(anilibria.New(cfg, log))
	srcReg.Register(releases.NewProwlarrProvider(cfg.Prowlarr))
	srcReg.Register(jacred.New(cfg.Jacred))
	srcReg.Register(anilibria.New("", nil))
	srcReg.Register(cdnvideohub.New("", nil))
	srcReg.Register(collaps.New("", nil))
	// ---- end sources ----

	// Phase 4: releases (Prowlarr/Jacred via sources) and playback (TorrServer).
	releaseSvc := releases.NewService(pool, cfg, catalogSvc, log)
	releaseSvc.SetSources(srcReg)
	releases.NewHandlers(releaseSvc).Routes(api)
	playbackSvc := playback.NewService(pool, cfg, releaseSvc, log)
	playback.NewHandlers(playbackSvc).Routes(app, api)
	// Server downloads (internal/downloads): /downloads; local files replace TorrServer in the stream proxy.
	downloadsSvc := downloads.NewService(downloads.Deps{Pool: pool, Playback: playbackSvc, Catalog: catalogSvc, Hub: hub, Audit: auditLog, Config: cfg.Library, Log: log})
	playbackSvc.SetLibrary(downloadsSvc)
	downloadsSvc.Routes(api)

	// Sources API: GET /sources, GET /media/:id/online, /admin/sources*.
	// onlineSvc implements sources.VariantLookup for online playback.
	onlineSvc := sourcesapi.NewService(pool, srcReg, catalogSvc, log)
	srcHandlers := sourcesapi.NewHandlers(onlineSvc, profileStore, auditLog)
	srcHandlers.Routes(api)
	profiles.SetKnownSources(srcReg.IDs)
	playbackSvc.SetOnline(srcReg, onlineSvc) // online playback (internal/playback/online.go)
	// Intro / recap / credits times for «Пропустить заставку» (internal/segments).
	segHTTP := tmdb.HTTPClient(cfg.TMDB, 6*time.Second)
	var segProviders []segments.Provider
	if u := cfg.Segments.TheIntroDBURL; u != "" && u != "off" {
		segProviders = append(segProviders, segments.TheIntroDB{Base: u, HTTP: segHTTP})
	}
	if u := cfg.Segments.IntroDBURL; u != "" && u != "off" {
		segProviders = append(segProviders, segments.IntroDB{Base: u, HTTP: segHTTP})
	}
	playbackSvc.SetSegments(segments.New(pool, log.With("module", "segments"), segProviders...))
	// Phase 7: IPTV (internal/iptv); live playback through playback/live.go.
	iptvSvc := iptv.NewService(iptv.Deps{Pool: pool, Config: cfg.IPTV, Profiles: profileStore, Audit: auditLog,
		LogoDir: cfg.Catalog.ImageCacheDir + "/iptv", Log: log})
	iptvSvc.Routes(api)
	playbackSvc.SetLive(iptvSvc, cfg.IPTV.AllowPrivate)
	profiles.SetKnownIPTVPlaylists(iptvSvc.PlaylistIDs)
	// YouTube «Видео» (internal/video) via Invidious; streams through playback/video.go.
	videoClient, err := video.NewClient(cfg.Video.InvidiousURL, nil)
	if err != nil {
		log.Error("video disabled", "err", err)
		videoClient, _ = video.NewClient("", nil)
	}
	videoClient.SetLocale(cfg.Video.Lang, cfg.Video.Region)
	videoSvc := video.NewService(video.Deps{Pool: pool, Client: videoClient, Profiles: profileStore, Region: cfg.Video.Region,
		ThumbDir: cfg.Catalog.ImageCacheDir + "/video", Log: log, Prefs: videoPrefs(profileStore)})
	videoSvc.Routes(api)
	playbackSvc.SetVideo(videoSvc)

	admin := api.Group("/admin", auth.RequireAdmin())
	users.NewHandlers(userStore, usersAuth{authSvc}, auditLog).AdminRoutes(admin)
	users.NewHandlers(userStore, usersAuth{authSvc}, auditLog).DirectoryRoutes(api, auth.RequireUser())
	watchHandlers.AdminRoutes(admin, hub)
	msgHandlers.AdminRoutes(admin)
	srcHandlers.AdminRoutes(admin)
	forYouSvc.AdminRoutes(admin)
	downloadsSvc.AdminRoutes(admin) // /admin/storage, /admin/torrserver/torrents
	iptvSvc.AdminRoutes(admin)      // /admin/iptv/*
	videoSvc.AdminRoutes(admin)     // /admin/video/status
	admin.Get("/integrations", func(c fiber.Ctx) error {
		return c.JSON(httpx.List(checker.Statuses(c.Context())))
	})
	sysmonSvc := sysmon.NewService(sysmon.Deps{
		Version:       Version,
		Socket:        cfg.HostmonSocket,
		ImageCacheDir: cfg.Catalog.ImageCacheDir,
		Pool:          pool,
		TorrServer:    torrserver.New(cfg.TorrServer),
		Hub:           hub,
		ActiveStreams: playback.ActiveStreams,
		Integrations:  checker.Statuses,
		Transcoder:    transcoderStats(playbackSvc),
	})
	sysmonSvc.AdminRoutes(admin)
	clientLog.Routes(api)
	clientLog.AdminRoutes(admin)
	appSettings.AdminRoutes(admin)
	deviceHandlers.AdminRoutes(admin) // super_admin: /admin/devices*
	pairHandlers.AdminRoutes(admin)   // super_admin: /admin/pairing*
	newStatusService(cfg.TorrServer, checker.Statuses).withSeasonal(appSettings.SeasonalEnabled).withCPU(sysmonSvc.CPUNow).Routes(api)
	newSpeedtestService().Routes(api) // GET /speedtest: background connection speed tests (TV + PWA)

	api.Use(func(c fiber.Ctx) error { return httpx.NotFound() })

	return &Server{App: app, Auth: authSvc, Pairing: pairSvc, Hub: hub, Catalog: catalogSvc, Playback: playbackSvc, Watch: watchSvc, Sysmon: sysmonSvc, Ratings: ratingsSvc, Awards: awardsSvc, Sources: srcReg, Online: onlineSvc, ClientLog: clientLog, Imports: importSvc, ForYou: forYouSvc, Curated: curatedSvc, Downloads: downloadsSvc, IPTV: iptvSvc, Video: videoSvc, Trivia: triviaSvc,
		InvidiousRestart: ivrestart.New(cfg.InvidiousRestart, playback.LastVideoStream, log)}
}

// RunCleanup periodically prunes expired sessions and pairing requests.
func (s *Server) RunCleanup(ctx context.Context, log *slog.Logger) {
	// Super_admin view: flip expired pairing requests live (admin.devices.updated).
	go s.Pairing.WatchExpiries(ctx, 10*time.Second, func() { s.Hub.AdminDevicesChanged("pairing.expired") })
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for {
		if err := s.Auth.Cleanup(ctx); err != nil && ctx.Err() == nil {
			log.Warn("session cleanup failed", "err", err)
		}
		if err := s.Pairing.Cleanup(ctx); err != nil && ctx.Err() == nil {
			log.Warn("pairing cleanup failed", "err", err)
		}
		if err := s.Watch.Cleanup(ctx); err != nil && ctx.Err() == nil {
			log.Warn("watch cleanup failed", "err", err)
		}
		if err := s.ClientLog.Cleanup(ctx); err != nil && ctx.Err() == nil {
			log.Warn("client error cleanup failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func proxyHeader(cfg *config.Config) string {
	if len(cfg.TrustedProxies) > 0 {
		return fiber.HeaderXForwardedFor
	}
	return ""
}

func proxyIPs(list []string) []string {
	var out []string
	for _, p := range list {
		if net.ParseIP(p) != nil || strings.Contains(p, "/") {
			out = append(out, p)
		}
	}
	return out
}

// deviceAccess adapts the stores the realtime hub needs.
type deviceAccess struct {
	s     *devices.Store
	pool  *pgxpool.Pool
	users *users.Store
	audit *audit.Logger
}

func (d deviceAccess) MediaExists(ctx context.Context, mediaID string) (bool, error) {
	var ok bool
	err := d.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media WHERE id = $1)`, mediaID).Scan(&ok)
	return ok, err
}

func (d deviceAccess) Sender(ctx context.Context, userID string) (realtime.Sender, error) {
	u, err := d.users.ByID(ctx, userID)
	if err != nil {
		return realtime.Sender{}, err
	}
	return realtime.Sender{UserID: u.ID, Username: u.Username, DisplayName: u.DisplayName}, nil
}

func (d deviceAccess) DeviceAccess(ctx context.Context, p *auth.Principal, deviceID string) (realtime.Grant, error) {
	dev, err := d.s.AccessFor(ctx, p, deviceID)
	if err == devices.ErrNotFound {
		return realtime.Grant{}, nil
	}
	if err != nil {
		return realtime.Grant{}, err
	}
	return realtime.Grant{Level: dev.Access, ViaAdmin: dev.Via == devices.ViaAdmin, OwnerUserID: dev.OwnerUserID}, nil
}

// AdminCommand audits a super_admin's command to a device that isn't theirs
// or shared with them.
func (d deviceAccess) AdminCommand(ctx context.Context, p *auth.Principal, deviceID, ownerUserID, commandType string) {
	d.audit.Record(ctx, audit.Event{UserID: p.UserID, DeviceID: deviceID, Action: "admin.device_command",
		TargetType: "device", TargetID: deviceID,
		Metadata: map[string]any{"type": commandType, "owner_user_id": ownerUserID}})
}

func (d deviceAccess) AuthorizedUserIDs(ctx context.Context, deviceID string) ([]string, error) {
	return d.s.AuthorizedUserIDs(ctx, deviceID)
}

// videoPrefs reads a profile's video settings (ProfileSettings.video_*).
func videoPrefs(st *profiles.Store) func(context.Context, string) video.Prefs {
	return func(ctx context.Context, id string) video.Prefs {
		p := video.Prefs{Quality: video.DefaultQuality, HideShorts: video.DefaultHideShorts}
		if s, err := st.GetSettings(ctx, id); err == nil {
			if s.VideoQuality != nil {
				p.Quality = *s.VideoQuality
			}
			if s.VideoHideShorts != nil {
				p.HideShorts = *s.VideoHideShorts
			}
		}
		return p
	}
}

// usersAuth adapts auth.Service for the admin user handlers.
type usersAuth struct{ s *auth.Service }

func (u usersAuth) HashPassword(ctx context.Context, pw string) (string, error) {
	return auth.HashPassword(ctx, pw)
}
func (u usersAuth) ValidatePassword(pw string) error { return auth.ValidatePassword(pw) }
func (u usersAuth) SetPassword(ctx context.Context, userID, pw, keep string) error {
	return u.s.SetPassword(ctx, userID, pw, keep)
}
func (u usersAuth) RevokeAllForUser(ctx context.Context, userID string, devices bool) error {
	return u.s.RevokeAllForUser(ctx, userID, devices)
}
func (u usersAuth) CallerID(c fiber.Ctx) string {
	if p := auth.PrincipalFrom(c); p != nil {
		return p.UserID
	}
	return ""
}
func (u usersAuth) CallerRole(c fiber.Ctx) string {
	if p := auth.PrincipalFrom(c); p != nil {
		return p.Role
	}
	return ""
}

// transcoderStats adapts the compat transcoder's metrics for the admin
// Server tab (nil when compat streams are off).
func transcoderStats(p *playback.Service) func(context.Context) *sysmon.TranscoderStats {
	if !p.CompatConfigured() {
		return nil
	}
	return func(ctx context.Context) *sysmon.TranscoderStats {
		m := p.TranscoderMetrics(ctx)
		if m == nil {
			return &sysmon.TranscoderStats{}
		}
		return &sysmon.TranscoderStats{OK: true, ActiveJobs: m.ActiveJobs, ActiveSubtitleJobs: m.ActiveSubtitleJobs, MaxJobs: m.MaxJobs,
			JobsStarted: m.JobsStarted, JobsRejected: m.JobsRejected, JobsFailed: m.JobsFailed}
	}
}
