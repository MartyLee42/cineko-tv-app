#!/bin/sh
# Stand-in for ffmpeg in unit tests. Records its pid and arguments, then
# behaves per FAKE_MODE: stream (write until killed), short (a few bytes),
# fail (error on stderr, exit 1), silent (no output until killed),
# hls (an EVENT playlist with 3 segments in the cwd, then runs until killed).
# FAKE_FAIL_ON: fail like a broken GPU when an argument equals it.
# FAKE_RUNS: a line per run is appended to this file.
[ -n "$FAKE_PIDFILE" ] && echo $$ > "$FAKE_PIDFILE"
[ -n "$FAKE_ARGS" ] && printf '%s\n' "$@" > "$FAKE_ARGS"
[ -n "$FAKE_RUNS" ] && echo x >> "$FAKE_RUNS"
if [ -n "$FAKE_FAIL_ON" ]; then
  for a in "$@"; do
    if [ "$a" = "$FAKE_FAIL_ON" ]; then echo "Failed to initialise VAAPI connection: -1 (unknown libva error)." >&2; exit 1; fi
  done
fi
case "$FAKE_MODE" in
  short) printf 'ftypfake'; exit 0 ;;
  fail) echo "[http @ 0x1] HTTP error 404 Not Found http://ts.local:5665/stream?link=abc" >&2; echo "Error opening input $FAKE_INPUT" >&2; exit 1 ;;
  silent) while :; do sleep 0.05; done ;;
  hls)
    printf 'init' > init.mp4
    for i in 0 1 2; do printf 'segment%s' "$i" > "seg$i.m4s"; done
    printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000000,\nseg0.m4s\n#EXTINF:4.000000,\nseg1.m4s\n#EXTINF:4.000000,\nseg2.m4s\n' > index.m3u8
    while :; do sleep 0.05; done ;;
  *) while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; sleep 0.02; done ;;
esac
