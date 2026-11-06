# syntax=docker/dockerfile:1

# ---- dev: live-reloading API (used by deployments/compose.dev.yaml) ----
FROM golang:1.27-bookworm AS dev
RUN go install github.com/air-verse/air@v1.67.4
WORKDIR /src/services/api
CMD ["air", "-c", ".air.toml"]

# ---- build ----
FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X martytv/api/internal/server.Version=${VERSION}" \
      -o /out/martytv ./cmd/martytv
# Image proxy cache (IMAGE_CACHE_DIR=/var/cache/martytv/images). Created in the
# image so a named volume mounted on /var/cache/martytv inherits nonroot ownership.
RUN mkdir -p /out/cache/images

# ---- martytv-hostmon: host monitor binary (a systemd service on the host,
# not a container). deploy.sh exports it with
#   docker build --target hostmon --output type=local,dest=DIR services/api
FROM build AS hostmon-build
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/martytv-hostmon ./cmd/martytv-hostmon
FROM scratch AS hostmon
COPY --from=hostmon-build /out/martytv-hostmon /martytv-hostmon

# ---- runtime: static binary on distroless, non-root ----
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=build /out/martytv /martytv
COPY --from=build --chown=65532:65532 /out/cache /var/cache/martytv
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 CMD ["/martytv", "healthcheck"]
ENTRYPOINT ["/martytv"]
CMD ["serve"]
