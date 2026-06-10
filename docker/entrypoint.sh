#!/bin/sh
# entrypoint.sh — bring up the loopback Sapling-params server, then exec the relay.
#
# WHY A WRAPPER (verified, not assumed):
#   The relay never serves its own proving params; the SDK fetches them over the
#   network via global fetch(). Node 22 fetch() can't read file:// URLs, so we run
#   a tiny loopback HTTP server (sapling-params-server.mjs) that re-serves the
#   already-baked, already-checksum-verified params, then point the relay at it via
#   SAPLING_PARAMS_URL=http://127.0.0.1:<port>/ (set in the image ENV).
#
# ONLY the server command needs the params. Admin subcommands (init/doctor/jobs)
# do not generate proofs, so we start the params server ONLY for `start` — keeping
# `relay init` (offline key mint) and `relay doctor` (preflight) fast and side-effect
# free. tini is PID-1 (from the ENTRYPOINT), so it forwards SIGTERM/SIGINT to THIS
# script's exec'd `relay start` and the drain handler in start.ts runs correctly.
set -e

SAPLING_PARAMS_DIR="${SAPLING_PARAMS_DIR:-/opt/sapling-params}"
SAPLING_PARAMS_PORT="${SAPLING_PARAMS_PORT:-8091}"

# Subcommand is the first arg (default "start", matching the image CMD).
CMD="${1:-start}"

if [ "$CMD" = "start" ]; then
  # Launch the loopback params server in the background. It binds 127.0.0.1 only.
  SAPLING_PARAMS_DIR="$SAPLING_PARAMS_DIR" SAPLING_PARAMS_PORT="$SAPLING_PARAMS_PORT" \
    node /opt/sapling-params-server.mjs &
  PARAMS_PID=$!

  # Clean up the params server if BOOT FAILS before the exec below (e.g. the
  # readiness loop gives up). NOTE: once `exec` replaces this shell, this trap is
  # gone — steady-state teardown is handled by `tini -g` (Dockerfile ENTRYPOINT),
  # which signals the whole process group, including the backgrounded params server.
  trap 'kill "$PARAMS_PID" 2>/dev/null || true' EXIT INT TERM

  # Wait until the loopback server answers before starting the relay, so the first
  # proof never races a not-yet-listening params server. ~5s budget is ample for a
  # localhost listen(); the params files are already on disk.
  i=0
  until node -e "fetch('http://127.0.0.1:${SAPLING_PARAMS_PORT}/sapling-output.params',{method:'HEAD'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 50 ]; then
      echo "[entrypoint] FATAL: sapling-params server did not come up on 127.0.0.1:${SAPLING_PARAMS_PORT}" >&2
      exit 1
    fi
    sleep 0.1
  done
  echo "[entrypoint] sapling-params server ready on 127.0.0.1:${SAPLING_PARAMS_PORT}; starting relay"
fi

# exec so the relay inherits this PID and receives tini's forwarded signals
# directly (graceful drain: stop intake -> finish in-flight -> release lock -> exit).
# Pass --import EXPLICITLY (not just via NODE_OPTIONS) so a user's .env that clears
# or overrides NODE_OPTIONS can never silently break the SDK's worker isolate — the
# shim install is LOAD-BEARING (see src/runtime/saplingRequireShim.ts).
exec node --import=file:///app/dist/runtime/saplingRequireShim.js dist/cli/index.js "$@"
