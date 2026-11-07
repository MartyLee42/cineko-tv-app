# Cineko — notes for Claude Code

Self-hosted household media center: a Media Station X **TV app** (`apps/tv`), a **PWA**
(`apps/web`), **Cineko Music** (`services/music`), a Go API (`services/api`), an ffmpeg
sidecar (`services/transcoder`) and **Cineko Lite** (`apps/lite`, serverless, GitHub Pages).
The mascot is a robot-cat named Cineko.

## Installing for a user

Everything runs in Docker; the host needs only Docker + the compose plugin (≥ 2.24).

```sh
./install.sh                     # interactive: address, TMDB token, optional DeepSeek / proxy, admin
./install.sh --help              # every flag; each also has a CINEKO_* env var
# Non-interactive (good for agents):
CINEKO_ADMIN_PASSWORD='…' ./install.sh --yes --domain tv.example.com --tmdb <token> --admin-user me
CINEKO_ADMIN_PASSWORD='…' ./install.sh --yes --lan            # LAN only, plain HTTP on :80
```

- It writes `.env` (0600, secrets generated, never overwritten), starts `deployments/compose.yaml`
  (Cineko + Prowlarr + FlareSolverr + TorrServer + Invidious), configures Prowlarr (key, FlareSolverr
  proxy, public indexers) and creates the super admin. Re-running is safe.
- Prebuilt images: `ghcr.io/martylee42/cineko-tv-app-{api,web,music,transcoder}`; `--build` builds
  from the checkout instead (~10 min).
- Operate with `scripts/cineko.sh <compose args>` (e.g. `scripts/cineko.sh ps`, `logs -f api`),
  `scripts/update.sh`, `scripts/backup.sh`. Health: `curl http://<host>/healthz`; integrations:
  `scripts/cineko.sh exec web wget -qO- http://api:8080/readyz` (the api image is distroless).
- Prowlarr / TorrServer UIs listen on 127.0.0.1 only (9696 / 8090): use an SSH tunnel.
- Blocked TMDB/YouTube: `--proxy socks5h://host:port` or `--vpn` (gluetun, `gluetun.env`).
- Full guide and troubleshooting: `docs/deployment.md`.

Never print or commit `.env`, `gluetun.env` or any key; ask the user for tokens instead of guessing.

## Developing

No local Go/Node needed — use Docker:

```sh
make dev          # dev stack on :8080 (PWA /, TV /tv/, music /music/), live reload
make admin USER=me
make test         # Go (with the dev Postgres) + JS unit tests
make lint typecheck e2e
```

One-off without the dev stack:

```sh
docker run --rm -u $(id -u):$(id -g) -v $PWD:/w -w /w -e HOME=/tmp node:22-bookworm-slim \
  sh -c 'corepack pnpm install --frozen-lockfile && corepack pnpm -r --filter "!@martytv/e2e" typecheck && corepack pnpm -r --filter "!@martytv/e2e" test'
docker run --rm -v $PWD:/w -w /w/services/music golang:1.27-bookworm go test ./...
# services/api tests need Postgres: TEST_DATABASE_URL=postgres://…/martytv_test?sslmode=disable go test ./...
```

`apps/lite` is a standalone npm project (not in the pnpm workspace):
`cd apps/lite && npm ci && npm test && npm run build`.

## Conventions

- Product name in user-facing text: **Cineko** (music: **Cineko Music**). Internal identifiers keep the
  old `martytv` prefix — Go module `martytv/api`, `@martytv/*` packages, the `/martytv` binary, DB
  user/name, `mt_session` cookie, `martytv.*` localStorage keys, `MARTYTV_*` build vars. Don't rename
  them: existing installs depend on them.
- UI strings live in `packages/ui/src/locales/*.{ru,en,kk}.ts` (Russian first; keep all three in sync —
  `kk.test.ts` checks Kazakh has every key and placeholder). Kazakh UI shows catalog metadata in Russian (`catalogLang`).
- The API contract is `packages/contracts/openapi.yaml`; regenerate the TS client with `make gen`.
- Docs: `docs/architecture.md` (how things work), `docs/api.md`, `docs/deployment.md`.
- CI (`.github/workflows/ci.yml`, manual trigger only) runs the same Go/JS tests, compose validation and shellcheck;
  `images.yml` publishes the images, `pages.yml` deploys Cineko Lite — all three run only when started by hand.
