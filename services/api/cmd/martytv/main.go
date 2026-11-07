// Command martytv runs the Cineko API server and admin tasks.
//
//	martytv serve                          run migrations, then serve HTTP
//	martytv migrate                        apply migrations and exit
//	martytv admin create --username NAME [--role admin|super_admin]
//	                                       create an administrator (password from stdin)
//	martytv admin set-role --username NAME --role user|admin|super_admin
//	                                       change an existing account's role
//	martytv healthcheck                    exit 0 if the local server is healthy (for Docker)
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/config"
	"martytv/api/internal/db"
	"martytv/api/internal/server"
	"martytv/api/internal/users"
)

func main() {
	// All timestamps are handled and returned in UTC regardless of host TZ.
	time.Local = time.UTC
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "migrate":
		err = migrate()
	case "admin":
		err = admin(os.Args[2:])
	case "healthcheck":
		err = healthcheck()
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: martytv serve | migrate | admin create --username NAME [--role admin|super_admin] | admin set-role --username NAME --role user|admin|super_admin | healthcheck")
	os.Exit(2)
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level))
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := newLogger(cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	srv := server.New(cfg, pool, log)
	go srv.RunCleanup(ctx, log)
	go srv.Sysmon.Run(ctx)           // 10 s samples for the admin Server tab
	go srv.Catalog.Run(ctx)          // warms home rows; no-op without TMDB credentials
	go srv.Ratings.Run(ctx)          // Kinopoisk id matching + rating refreshes
	go srv.Awards.Run(ctx)           // awards/nominations from Wikidata (backfill, 60-day re-check)
	go srv.Sources.Run(ctx)          // provider health probes every 30 min
	go srv.Imports.Run(ctx)          // rating imports; resumes jobs a restart interrupted
	go srv.ForYou.Run(ctx)           // daily recommendations run (FORYOU_DAILY_AT, Moscow)
	go srv.Curated.Run(ctx)          // «Подборки»: resolve list items into the catalog (startup + daily)
	go srv.IPTV.Run(ctx)             // IPTV playlists 12 h, guides 6 h, favorite/recent channel probes
	go srv.Watch.RunNewEpisodes(ctx) // nightly «Новые серии» check (NEW_EPISODES_AT, NEW_EPISODES_TZ)
	go srv.Video.Run(ctx)            // Invidious health 1 min, subscription feeds 30 min
	// Server downloads: queue, resume after restarts, hourly eviction janitor.
	go srv.Downloads.Run(ctx)
	if srv.Metrics != nil {
		go srv.Metrics.Run(ctx) // /metrics snapshot every 20 s while scraped (METRICS_TOKEN set)
	}

	n, _ := users.NewStore(pool).Count(ctx)
	if n == 0 {
		log.Warn("no users yet: create the first administrator with `martytv admin create --username <name>`")
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.ListenAddr, "public_base_url", cfg.PublicBaseURL.String(), "version", server.Version)
		errCh <- srv.App.Listen(cfg.ListenAddr, fiberListenConfig())
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.App.ShutdownWithContext(shutdownCtx)
}

func migrate() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	return db.Migrate(ctx, pool)
}

func admin(args []string) error {
	if len(args) > 0 && args[0] == "set-role" {
		return adminSetRole(args[1:])
	}
	if len(args) == 0 || args[0] != "create" {
		return errors.New("usage: martytv admin create --username NAME [--display-name NAME] [--role admin|super_admin]\n" +
			"       martytv admin set-role --username NAME --role user|admin|super_admin")
	}
	fs := flag.NewFlagSet("admin create", flag.ContinueOnError)
	username := fs.String("username", "", "administrator username")
	display := fs.String("display-name", "", "display name")
	role := fs.String("role", auth.RoleAdmin, "admin or super_admin")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if !users.UsernamePattern.MatchString(*username) {
		return errors.New("--username must be 3-32 characters: letters, digits, . _ -")
	}
	if !auth.IsAdminRole(*role) {
		return errors.New("--role must be admin or super_admin")
	}
	pw, err := readPassword()
	if err != nil {
		return err
	}
	if err := auth.ValidatePassword(pw); err != nil {
		return fmt.Errorf("password %w", err)
	}

	ctx := context.Background()
	pool, err := openMigrated(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	hash, err := auth.HashPassword(ctx, pw)
	if err != nil {
		return err
	}
	store := users.NewStore(pool)
	u, err := store.Create(ctx, *username, *display, *role, hash)
	if errors.Is(err, users.ErrUsernameTaken) {
		return errors.New("that username already exists")
	}
	if err != nil {
		return err
	}
	if err := store.CreateDefaultProfile(ctx, u); err != nil {
		return err
	}
	fmt.Printf("created %s %q (%s)\n", u.Role, u.Username, u.ID)
	return nil
}

func openMigrated(ctx context.Context) (*pgxpool.Pool, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// adminSetRole: martytv admin set-role --username NAME --role ROLE. Run on
// the server (shell access = full trust), e.g. to make the owner super_admin.
func adminSetRole(args []string) error {
	ctx := context.Background()
	pool, err := openMigrated(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	return setRole(ctx, pool, args, os.Stdout)
}

// setRole parses set-role flags and changes the role. It refuses to remove
// the last active super_admin or administrator, and is audited
// (admin.user_role_changed, actor = none, metadata via = cli).
func setRole(ctx context.Context, pool *pgxpool.Pool, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("admin set-role", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "account username")
	role := fs.String("role", "", "user, admin or super_admin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *username == "" || !users.ValidRole(*role) {
		return errors.New("usage: martytv admin set-role --username NAME --role user|admin|super_admin")
	}
	store := users.NewStore(pool)
	u, err := store.ByUsername(ctx, *username)
	if errors.Is(err, users.ErrNotFound) {
		return fmt.Errorf("no user %q", *username)
	}
	if err != nil {
		return err
	}
	if u.Role == *role {
		fmt.Fprintf(out, "%s is already %s\n", u.Username, u.Role)
		return nil
	}
	if err := store.GuardLockout(ctx, u, *role, false); err != nil {
		return err
	}
	if err := store.SetRole(ctx, u.ID, *role); err != nil {
		return err
	}
	audit.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil))).Record(ctx, audit.Event{
		Action: "admin.user_role_changed", TargetType: "user", TargetID: u.ID,
		Metadata: map[string]any{"from": u.Role, "to": *role, "via": "cli"}})
	fmt.Fprintf(out, "%s: %s → %s\n", u.Username, u.Role, *role)
	return nil
}

// readPassword reads from the terminal without echo, or one line from a pipe.
func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		a, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		fmt.Fprint(os.Stderr, "Repeat password: ")
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if string(a) != string(b) {
			return "", errors.New("passwords do not match")
		}
		return string(a), nil
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no password on stdin")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func healthcheck() error {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" || strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
		if addr == "127.0.0.1" {
			addr += ":8080"
		}
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %d", resp.StatusCode)
	}
	return nil
}
