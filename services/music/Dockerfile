# syntax=docker/dockerfile:1
# martytv-music: Cineko Music at /music — Go service + its web app + ffmpeg
# (torrent files browsers can't play and CUE album images → MP3 on the fly).
# Build context: services/music.

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/martytv-music .

# Tests: docker build --target test -t martytv-music:test services/music && docker run --rm martytv-music:test
FROM build AS test
CMD ["go", "test", "-count=1", "./..."]

# ffmpeg pinned to the 8.1.3 series of Alpine 3.24, like services/transcoder.
FROM alpine:3.24 AS runtime
RUN apk add --no-cache "ffmpeg~8.1.3" ca-certificates tzdata \
 && addgroup -S -g 65532 music \
 && adduser -S -D -H -u 65532 -G music music \
 && mkdir -p /data && chown 65532:65532 /data && chmod 700 /data \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame
COPY --from=build /out/martytv-music /usr/local/bin/martytv-music
COPY --from=web /web/dist /srv/music
# The same app built for "/" (Cineko Music on its own host, MUSIC_DOMAIN).
COPY --from=web /web/dist-root /srv/music-root
USER 65532:65532
ENV LISTEN_ADDR=:8080 MUSIC_DATA_DIR=/data MUSIC_STATIC_DIR=/srv/music MUSIC_ROOT_STATIC_DIR=/srv/music-root
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 CMD ["martytv-music", "healthcheck"]
ENTRYPOINT ["martytv-music"]
