#!/usr/bin/env bash
# Real-ffmpeg integration test for martytv-transcoder (dev machine only).
#
#   services/transcoder/scripts/integration.sh [image]   (default martytv-transcoder:dev)
#
# 1. Generates a small MKV in a throwaway container: H.264 (keyframe every
#    5 s) + two AC3 tracks (48 kHz stereo "rus/LostFilm", 44.1 kHz 5.1 "eng")
#    + an SRT subtitle.
# 2. Serves it as a fake TorrServer (/stream, basic auth, Range) with Caddy.
# 3. Runs the real transcoder container on a private network and checks:
#    fragmented MP4 with AAC, start= snapping to the keyframe (X-Stream-Start),
#    audio=<index> picking the second track, WebVTT extraction, forged jobs.
# 4. Measures ffmpeg CPU for a 1080p (8 Mb/s H.264 + AC3 5.1) remux.
# Never touches the real TorrServer. Everything is removed at the end.
set -euo pipefail

IMAGE=${1:-martytv-transcoder:dev}
CADDY=caddy:2.10-alpine
SECRET=integration-secret-0123456789abcdef0123456789
TAG=martytv-it-$$
WORK=$(mktemp -d)
chmod 777 "$WORK"
DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sg docker -c docker"
dk() { if [ "$DOCKER" = docker ]; then docker "$@"; else sg docker -c "docker $(printf '%q ' "$@")"; fi; }

cleanup() {
  dk rm -f "$TAG-tc" "$TAG-ts" >/dev/null 2>&1 || true
  dk network rm "$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
[ -n "${KEEP:-}" ] || trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok  $*"; }

run() { dk run --rm --network "$TAG" -v "$WORK:/w" --entrypoint "$1" "$IMAGE" "${@:2}"; }

echo "==> fixture"
cat > "$WORK/sample.srt" <<'EOF'
1
00:00:05,000 --> 00:00:07,000
Первая реплика

2
00:00:40,000 --> 00:00:42,500
Реплика на сороковой секунде

3
00:01:10,000 --> 00:01:12,000
Последняя реплика
EOF
dk run --rm -v "$WORK:/w" --entrypoint ffmpeg "$IMAGE" -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=640x360:rate=24:duration=90 \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=90 \
  -f lavfi -i sine=frequency=880:sample_rate=44100:duration=90 \
  -i /w/sample.srt \
  -map 0:v -map 1:a -map 2:a -map 3:s \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 120 -keyint_min 120 -sc_threshold 0 \
  -c:a ac3 -b:a 192k -filter:a:1 "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" \
  -c:s srt \
  -metadata:s:a:0 language=rus -metadata:s:a:0 title=LostFilm -disposition:a:0 default \
  -metadata:s:a:1 language=eng -metadata:s:a:1 title=Original -disposition:a:1 0 \
  -metadata:s:s:0 language=rus \
  /w/sample.mkv
ok "sample.mkv $(du -h "$WORK/sample.mkv" | cut -f1)"

echo "==> fake TorrServer + transcoder"
HASH=$(dk run --rm "$CADDY" caddy hash-password --plaintext ts-pass)
cat > "$WORK/Caddyfile" <<EOF
:80 {
  basic_auth {
    ts $HASH
  }
  handle /stream {
    rewrite * /sample.mkv
  }
  root * /w
  file_server
}
EOF
dk network create --internal "$TAG" >/dev/null
dk run -d --name "$TAG-ts" --network "$TAG" --network-alias ts -v "$WORK:/w:ro" "$CADDY" caddy run --config /w/Caddyfile >/dev/null
dk run -d --name "$TAG-tc" --network "$TAG" --network-alias tc --cpus 3 --memory 1g \
  -e TRANSCODER_SECRET="$SECRET" -e TRANSCODER_MAX_JOBS=3 "$IMAGE" >/dev/null
for _ in $(seq 1 50); do
  run wget -q -O- http://tc:8090/healthz >/dev/null 2>&1 && break
  sleep 0.2
done
ok "healthy"

AUTH="Basic $(printf 'ts:ts-pass' | base64)"
INPUT="http://ts/stream?link=0000000000000000000000000000000000000000&index=1&play"
# job KIND [json fields…] → prints "body<TAB>signature"
job() {
  python3 - "$SECRET" "$@" <<'PY'
import hmac, hashlib, json, sys, time
secret, kind, extra = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "{}"
key = hmac.new(secret.encode(), b"martytv/transcoder/job/v1", hashlib.sha256).digest()
j = {"v": 1, "kind": kind, "exp": int(time.time()) + 60}
j.update(json.loads(extra))
body = json.dumps(j, separators=(",", ":"))
print(body + "\t" + hmac.new(key, body.encode(), hashlib.sha256).hexdigest())
PY
}
# post PATH KIND EXTRA OUTFILE → response headers on stdout
post() {
  local path=$1 kind=$2 extra=$3 out=$4 line body sig
  line=$(job "$kind" "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d.update(json.loads(sys.argv[2])); print(json.dumps(d))' "{\"input\":\"$INPUT\",\"auth\":\"$AUTH\"}" "$extra")")
  body=${line%$'\t'*}; sig=${line#*$'\t'}
  run wget -S -q -O "/w/$out" --header "X-Job-Signature: $sig" --header "Content-Type: application/json" --post-data "$body" "http://tc:8090$path" 2>&1 || true
}
probe() { run ffprobe -v error -of json "${@:2}" "/w/$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "==> remux from the start (default audio)"
H=$(post /v1/remux remux '{}' out0.mp4)
echo "$H" | grep -q "200 OK" || fail "remux status: $H"
echo "$H" | grep -qi "X-Stream-Start: 0.000" || fail "X-Stream-Start: $H"
P=$(probe out0.mp4 -show_format -show_streams)
[ "$(echo "$P" | jget 'd["format"]["format_name"]')" = "mov,mp4,m4a,3gp,3g2,mj2" ] || fail "container"
[ "$(echo "$P" | jget '[s["codec_name"] for s in d["streams"]]')" = "['h264', 'aac']" ] || fail "codecs $(echo "$P" | jget '[s["codec_name"] for s in d["streams"]]')"
[ "$(echo "$P" | jget '[s.get("channels") for s in d["streams"] if s["codec_type"]=="audio"][0]')" = "2" ] || fail "channels"
[ "$(echo "$P" | jget '[s.get("sample_rate") for s in d["streams"] if s["codec_type"]=="audio"][0]')" = "48000" ] || fail "default track"
grep -q moof "$WORK/out0.mp4" && grep -q mvex "$WORK/out0.mp4" || fail "not fragmented"
D=$(probe out0.mp4 -show_entries format=duration | jget 'round(float(d["format"]["duration"]))')
[ "$D" -ge 89 ] && [ "$D" -le 91 ] || fail "duration $D"
ok "fMP4 (moof/mvex), h264 copy + AAC stereo 48 kHz, ${D}s"

echo "==> start=33 snaps to the keyframe at 30"
H=$(post /v1/keyframe keyframe '{"start":33}' kf.json)
grep -q '"start":30' "$WORK/kf.json" || fail "keyframe: $(cat "$WORK/kf.json")"
ok "keyframe probe → $(cat "$WORK/kf.json")"
H=$(post /v1/remux remux '{"start":33}' out33.mp4)
echo "$H" | grep -qi "X-Stream-Start: 30.000" || fail "X-Stream-Start: $H"
D=$(probe out33.mp4 -show_entries format=duration | jget 'round(float(d["format"]["duration"]))')
[ "$D" -ge 59 ] && [ "$D" -le 61 ] || fail "duration after seek $D"
F=$(probe out33.mp4 -show_entries stream=codec_type,start_time)
VS=$(echo "$F" | jget '[round(float(s["start_time"]),2) for s in d["streams"] if s["codec_type"]=="video"][0]')
AS=$(echo "$F" | jget '[round(float(s["start_time"]),2) for s in d["streams"] if s["codec_type"]=="audio"][0]')
python3 -c "import sys; sys.exit(0 if abs($VS) < 0.1 and abs($AS) < 0.1 else 1)" || fail "start times video=$VS audio=$AS"
ok "X-Stream-Start: 30.000, ${D}s left, video/audio start at $VS/$AS"

echo "==> audio=2 selects the second track"
post /v1/remux remux '{"audio":2}' out-a2.mp4 >/dev/null
P=$(probe out-a2.mp4 -show_streams)
[ "$(echo "$P" | jget '[s.get("sample_rate") for s in d["streams"] if s["codec_type"]=="audio"][0]')" = "44100" ] || fail "second track not selected"
[ "$(echo "$P" | jget '[s.get("channels") for s in d["streams"] if s["codec_type"]=="audio"][0]')" = "2" ] || fail "5.1 not downmixed"
post /v1/remux remux '{"audio":2,"channels":6}' out-a2-51.mp4 >/dev/null
[ "$(probe out-a2-51.mp4 -show_streams | jget '[s.get("channels") for s in d["streams"] if s["codec_type"]=="audio"][0]')" = "6" ] || fail "5.1 option"
ok "44.1 kHz track (index 2), downmixed to stereo; channels=6 keeps 5.1"

echo "==> WebVTT extraction"
H=$(post /v1/subtitles subtitles '{"stream":3}' subs0.vtt)
echo "$H" | grep -qi "Content-Type: text/vtt" || fail "vtt type: $H"
head -1 "$WORK/subs0.vtt" | grep -q WEBVTT || fail "vtt header"
grep -q "00:40.000 --> 00:42.500" "$WORK/subs0.vtt" || fail "vtt cue: $(cat "$WORK/subs0.vtt")"
grep -q "сороковой" "$WORK/subs0.vtt" || fail "vtt text"
post /v1/subtitles subtitles '{"stream":3,"start":33}' subs33.vtt >/dev/null
# Timed from the keyframe (30 s), like the video: the 40 s cue is at 10 s.
grep -q "00:10.000 --> 00:12.500" "$WORK/subs33.vtt" || fail "vtt after seek: $(cat "$WORK/subs33.vtt")"
ok "3 cues, UTF-8; start=33 → cue at 00:10 (keyframe-relative)"

echo "==> refused jobs"
H=$(run wget -S -q -O /dev/null --header "X-Job-Signature: $(printf '0%.0s' $(seq 64))" --post-data '{"v":1,"kind":"remux","input":"http://ts/x","exp":9999999999}' http://tc:8090/v1/remux 2>&1 || true)
echo "$H" | grep -q "403" || fail "forged job: $H"
ok "forged signature → 403"

echo "==> CPU for a 1080p remux (8 Mb/s H.264 + AC3 5.1 640k → AAC stereo)"
dk run --rm -v "$WORK:/w" --entrypoint ffmpeg "$IMAGE" -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=1920x1080:rate=24:duration=120 \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=120" \
  -map 0:v -map 1:a -c:v libx264 -preset ultrafast -b:v 8M -maxrate 8M -bufsize 16M -g 48 \
  -c:a ac3 -b:a 640k -ac 6 /w/hd.mkv
cat > "$WORK/Caddyfile" <<EOF
:80 {
  basic_auth {
    ts $HASH
  }
  handle /stream {
    rewrite * /hd.mkv
  }
  root * /w
  file_server
}
EOF
dk exec "$TAG-ts" caddy reload --config /w/Caddyfile >/dev/null 2>&1
T0=$(date +%s.%N)
post /v1/remux remux '{}' hd.mp4 >/dev/null
T1=$(date +%s.%N)
# CPU seconds actually used by ffmpeg in the container (cgroup accounting).
CPU_US=$(dk exec "$TAG-tc" cat /sys/fs/cgroup/cpu.stat | awk '/^usage_usec/{print $2}')
python3 - "$CPU_US" "$T0" "$T1" <<'PY'
import sys
cpu = int(sys.argv[1]) / 1e6
wall = float(sys.argv[3]) - float(sys.argv[2])
print(f"  ok  container CPU so far {cpu:.2f} s (all jobs above + this one); 120 s of 1080p remuxed in {wall:.1f} s wall")
PY
dk run --rm -v "$WORK:/w" --entrypoint sh "$IMAGE" -c \
  'time -f "%U %S %e" nice -n 10 ffmpeg -y -hide_banner -loglevel error -nostdin -i /w/hd.mkv -map 0:V:0 -map "0:a:0?" -c:v copy -c:a aac -ac 2 -b:a 192k -sn -dn -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 /dev/null' 2>"$WORK/time.txt"
python3 - "$WORK/time.txt" <<'PY'
import sys
user, sys_, wall = map(float, open(sys.argv[1]).read().split()[-3:])
cpu = user + sys_
print(f"  ok  ffmpeg: {cpu:.2f} CPU-s (user {user:.2f} + sys {sys_:.2f}) for 120 s of 1080p in {wall:.2f} s wall")
print(f"  =>  {cpu / 120 * 100:.1f}% of one core while playing in real time")
PY

echo "==> all integration checks passed"
