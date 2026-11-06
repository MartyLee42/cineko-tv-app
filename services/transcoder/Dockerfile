# syntax=docker/dockerfile:1
# martytv-transcoder: Go service + Alpine's ffmpeg (video copy, or libx264 for
# codecs players can't decode; audio → AAC).

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
ARG VERSION=dev
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/martytv-transcoder .

# Tests with the real ffmpeg (hls_test.go needs it; the rest use fakes):
#   docker build --target test -t martytv-transcoder:test services/transcoder
#   docker run --rm -v "$PWD/services/transcoder:/src" -w /src martytv-transcoder:test
FROM alpine:3.24 AS test
RUN apk add --no-cache "ffmpeg~8.1.3" x265-libs
COPY --from=build /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOCACHE=/tmp/go-build HOME=/tmp
CMD ["go", "test", "-count=1", "./..."]

# ffmpeg is pinned to the 8.1.3 series of Alpine 3.24 (any -rN rebuild of it),
# so a rebuild never silently changes the major version.
FROM alpine:3.24 AS runtime
RUN apk add --no-cache "ffmpeg~8.1.3" \
 && addgroup -S -g 65532 transcoder \
 && adduser -S -D -H -u 65532 -G transcoder transcoder \
 && mkdir -p /var/cache/martytv-hls && chown 65532:65532 /var/cache/martytv-hls && chmod 700 /var/cache/martytv-hls \
 && ffmpeg -hide_banner -version | head -1
COPY --from=build /out/martytv-transcoder /usr/local/bin/martytv-transcoder
USER 65532:65532
# HLS sessions write segments here (a disk volume in production: they are
# far too large for the tmpfs /tmp, which counts against the memory limit).
ENV LISTEN_ADDR=:8090 TRANSCODER_HLS_DIR=/var/cache/martytv-hls
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 CMD ["martytv-transcoder", "healthcheck"]
ENTRYPOINT ["martytv-transcoder"]
