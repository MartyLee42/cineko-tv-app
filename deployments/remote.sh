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

# put_chunked SRC DST — a large file in 1 MiB parts, for a lossy link: each
# part has its own timeout and retries (a stalled TCP connection is dropped
# and reopened instead of waiting out the keepalive), parts already on the
# server are skipped (uploading the same file again continues: they're kept
# under /opt/martytv/.upload/<sha256> until it's assembled, abandoned ones
# for 2 days), and the
# result is checksum-verified. Needs `remote_quiet` / SSH_OPTS from above.
put_chunked() {
  local src=$1 dst=$2 sum size parts dir have i part try local_parts
  [ -f "$src" ] || { echo "upload: missing local file $src" >&2; return 1; }
  sum=$(sha256sum < "$src" | cut -d' ' -f1)
  size=$(stat -c %s "$src")
  parts=$(( (size + 1048575) / 1048576 ))
  dir=/opt/martytv/.upload/$sum
  local_parts=$(mktemp -d)
  split -b 1048576 -d -a 5 "$src" "$local_parts/p"
  # Complete parts the server already holds (an earlier, interrupted run).
  have=$(remote_quiet "find /opt/martytv/.upload -mindepth 1 -maxdepth 1 -mtime +2 -exec rm -rf {} + 2>/dev/null; mkdir -p '$dir' && cd '$dir' && find . -name 'p*' -size 1048576c -printf '%f\n'" 2>/dev/null || true)
  echo "    $((size / 1048576)) MB in $parts parts, $(printf '%s\n' "$have" | grep -c . || true) already on the server"
  i=0
  for part in "$local_parts"/p*; do
    i=$((i + 1))
    local name=${part##*/} psize
    psize=$(stat -c %s "$part")
    if [ "$psize" = 1048576 ] && printf '%s\n' "$have" | grep -qx "$name"; then continue; fi
    for try in 1 2 3 4 5 6 7 8; do
      # A dropped connection ends the remote cat early: keep only full parts.
      if timeout 120 ssh "${SSH_OPTS[@]}" "$USER_@$HOST" "cat > '$dir/$name.tmp' && [ \$(stat -c %s '$dir/$name.tmp') = $psize ] && mv '$dir/$name.tmp' '$dir/$name'" < "$part" 2>/dev/null; then break; fi
      [ "$try" -lt 8 ] || { echo "upload of $src: part $i/$parts failed $try times" >&2; rm -rf "$local_parts"; return 1; }
      # A stalled shared connection: drop it, the next call opens a fresh one.
      ssh -O exit "${SSH_OPTS[@]}" "$USER_@$HOST" 2>/dev/null || true
      sleep $((try * 3))
    done
    if [ $((i % 10)) = 0 ] || [ "$i" = "$parts" ]; then echo "    part $i/$parts"; fi
  done
  rm -rf "$local_parts"
  STEP_LABEL="assemble $dst" remote "set -e; cat '$dir'/p* > '$dst.tmp'
    [ \"\$(sha256sum < '$dst.tmp' | cut -d' ' -f1)\" = '$sum' ] || { echo 'checksum mismatch for $dst' >&2; rm -rf '$dst.tmp' '$dir'; exit 1; }
    mv '$dst.tmp' '$dst'; rm -rf '$dir'"
}
