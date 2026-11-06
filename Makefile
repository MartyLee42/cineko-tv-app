# Cineko developer commands. Everything runs in Docker.
DC_DEV  = docker compose -f deployments/compose.dev.yaml
# Full self-hosted stack (deployments/compose.yaml + optional compose.override.yaml).
DC_PROD = scripts/cineko.sh
export UID := $(shell id -u)
export GID := $(shell id -g)

.PHONY: dev dev-video down logs admin check test test-go test-transcoder test-js lint typecheck gen e2e install prod prod-pull prod-down prod-logs

dev:            ## Start the dev stack (Postgres, API, PWA, TV app, proxy) on :8080
	$(DC_DEV) up --build -d
	@echo "PWA:  http://localhost:8080"
	@echo "TV:   http://localhost:8080/tv/"

dev-video:      ## Also start Invidious + companion for the «Видео» tab (needs YouTube access)
	$(DC_DEV) --profile video up -d invidious-db companion invidious

down:           ## Stop the dev stack
	$(DC_DEV) down

logs:           ## Follow dev logs
	$(DC_DEV) logs -f --tail=100

admin:          ## Create an administrator: make admin USER=name [ROLE=super_admin]
	$(DC_DEV) exec api go run ./cmd/martytv admin create --username $(USER) --role $(or $(ROLE),admin)

gen:            ## Regenerate the TypeScript client from OpenAPI
	$(DC_DEV) run --rm install pnpm gen

typecheck:
	$(DC_DEV) run --rm install pnpm typecheck

lint:
	$(DC_DEV) run --rm install pnpm lint
	$(DC_DEV) run --rm --no-deps api go vet ./...

test-go:        ## Go unit + integration tests (uses the dev Postgres)
	$(DC_DEV) up -d postgres
	$(DC_DEV) run --rm -e TEST_DATABASE_URL=postgres://martytv:martytv-dev@postgres:5432/martytv_test?sslmode=disable api go test -count=1 ./...

test-transcoder: ## services/transcoder tests with the real ffmpeg (HLS output checked with ffprobe)
	docker build -q --target test -t martytv-transcoder:test services/transcoder >/dev/null
	docker run --rm -u $(UID):$(GID) -v "$(CURDIR)/services/transcoder:/src" -w /src martytv-transcoder:test

test-js:
	$(DC_DEV) run --rm install pnpm test

test: test-go test-transcoder test-js

check: lint typecheck test   ## Everything CI runs

e2e:            ## Browser end-to-end tests against the dev stack
	-printf 'e2e-password-123\n' | $(DC_DEV) exec -T api go run -buildvcs=false ./cmd/martytv admin create --username e2e-admin --role super_admin
	$(DC_DEV) exec -T api go run -buildvcs=false ./cmd/martytv admin set-role --username e2e-admin --role super_admin
	$(DC_DEV) --profile e2e run --rm e2e

install:        ## Guided install of the full stack (writes .env, starts, configures Prowlarr)
	./install.sh

prod:           ## Build from source and start the full stack (needs .env: run ./install.sh once)
	$(DC_PROD) up --build -d

prod-pull:      ## Start the full stack from prebuilt GHCR images
	$(DC_PROD) pull
	$(DC_PROD) up -d

prod-down:      ## Stop the full stack (data volumes are kept)
	$(DC_PROD) down

prod-logs:
	$(DC_PROD) logs -f --tail=100
