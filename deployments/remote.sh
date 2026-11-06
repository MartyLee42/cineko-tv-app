# SSH helpers for deploy.sh (sourced). Needs HOST, USER_, TMP; optional
# SERVER_PWD (password via askpass) and SERVER_PORT.
#
# Every helper fails loudly: a non-zero ssh exit prints which step failed and
# the exit code (255 = ssh itself: connection, auth or multiplexing).

SSH_OPTS=(
  -p "${SERVER_PORT:-22}"
  -o ControlMaster=auto -o ControlPath="$TMP/cm" -o ControlPersist=10m
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=20
  # Keep the shared connection alive through long image uploads. Generous:
  # while the server unpacks images it stops reading, keepalive replies queue
  # behind the upload, and a short limit killed the transfer (ssh exit 255).
  -o ServerAliveInterval=30 -o ServerAliveCountMax=40
)
if [ -n "${SSH_KNOWN_HOSTS:-}" ]; then SSH_OPTS+=(-o UserKnownHostsFile="$SSH_KNOWN_HOSTS"); fi
if [ -n "${SERVER_PWD:-}" ]; then
  printf '#!/bin/sh\nprintf "%%s\\n" "$MARTYTV_SSH_PWD"\n' > "$TMP/askpass"; chmod 700 "$TMP/askpass"
  export MARTYTV_SSH_PWD="$SERVER_PWD" SSH_ASKPASS="$TMP/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY=none
fi

_ssh_step() {
  local rc=0 stdin=$1 label=${STEP_LABEL:-}; shift
  if [ "$stdin" = 1 ]; then ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "$@" || rc=$?
  else ssh -n "${SSH_OPTS[@]}" "$USER_@$HOST" "$@" || rc=$?; fi
  if [ "$rc" -ne 0 ]; then
    echo "remote step failed (ssh exit $rc): ${label:-$(printf '%s' "$*" | head -n1 | cut -c1-120)}" >&2
    return "$rc"
  fi
}

# remote CMD — run CMD on the server; never reads the script's stdin.
remote() { _ssh_step 0 "$@"; }

# remote_in CMD — the same, feeding this process's stdin to CMD (uploads).
remote_in() { _ssh_step 1 "$@"; }

# remote_quiet CMD — like remote, without stdin (probes in loops must not
# swallow the script's stdin) and without the failure message.
remote_quiet() { ssh -n "${SSH_OPTS[@]}" "$USER_@$HOST" "$@"; }

# put_small SRC DST [MODE] — a small text file (unit, compose, settings),
# sent inside the command (base64) instead of over stdin, then checked.
put_small() {
  local src=$1 dst=$2 mode=${3:-600} b64 sum
  [ -f "$src" ] || { echo "upload: missing local file $src" >&2; return 1; }
  b64=$(base64 -w0 < "$src")
  sum=$(sha256sum < "$src" | cut -d' ' -f1)
  STEP_LABEL="upload $src → $dst" remote "set -e; umask 077; printf '%s' '$b64' | base64 -d > '$dst'; chmod $mode '$dst'
    [ \"\$(sha256sum < '$dst' | cut -d' ' -f1)\" = '$sum' ] || { echo 'checksum mismatch for $dst' >&2; exit 1; }"
}

# put_big SRC DST [MODE] — a large file over stdin, size-checked, one retry.
put_big() {
  local src=$1 dst=$2 mode=${3:-755} size got attempt
  [ -f "$src" ] || { echo "upload: missing local file $src" >&2; return 1; }
  size=$(stat -c %s "$src")
  for attempt in 1 2; do
    if STEP_LABEL="upload $src → $dst" remote_in "cat > '$dst' && chmod $mode '$dst'" < "$src"; then
      got=$(remote_quiet "stat -c %s '$dst'" || true)
      [ "$got" = "$size" ] && return 0
      echo "upload of $dst: $got of $size bytes (attempt $attempt)" >&2
    fi
  done
  return 1
}
