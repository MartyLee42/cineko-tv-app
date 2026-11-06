#!/bin/sh
# Stand-in for ffprobe: a keyframe at 118.5 s (plus a non-key packet first).
[ -n "$FAKE_PROBE_COUNT" ] && echo x >> "$FAKE_PROBE_COUNT"
cat <<'J'
{"packets":[{"pts_time":"118.400000","dts_time":"118.400000","flags":"__"},{"pts_time":"118.500000","dts_time":"118.500000","flags":"K__"}],"format":{"start_time":"0.000000"}}
J
