#!/usr/bin/env bash
# deploy-host-logs.sh <bot|speck|glorb> [--since DUR] [--input FILE|-] [--verbose]
#
# Runs ON THE DEBIAN DEPLOY HOST (docs/deploy-host.md §4): fetches
# `docker compose logs` for one service and classifies the output against a
# table of signatures GREPPED FROM THE REAL EMIT SITES in this repo (see the
# file:line comments on every pattern — no invented strings).
#
# Exit-code contract (stdout is exactly one VERDICT= line, except exits 3/4):
#   0  VERDICT=clean count=0             — no crash, no memory-degraded signature
#   1  VERDICT=crash count=N             — crash bucket > 0 (wins over degraded)
#   2  VERDICT=memory-degraded count=N   — degraded bucket > 0, crash == 0
#   3  usage error (bad service, bad --since value, bad --input target)
#   4  log-fetch failure (docker missing / compose error)
#
# --input FILE (or `--input -` = stdin) is the DOCKER-FREE seam: it skips the
# compose invocation AND the docker inspect probe entirely and classifies the
# given text — this is what tests/deployHostLogs.test.js drives, so the gate
# host never needs docker. In --input mode --since is accepted and ignored.
#
# Precedence rule: a line matching ANY memory-degraded signature is NEVER
# counted as crash, even when it also contains `Error:` — the degraded
# messages interpolate err.message (service/ai/memory/memoryManager.js:88),
# e.g. `AI: memory unavailable — Error: no such table: facts` is a degraded
# line, not a crash. Order per line: degraded first, then crash.
#
# bash 3.2 compatible (macOS gate host): plain indexed arrays, no mapfile,
# no declare -A, no `&>`.
set -euo pipefail

usage() {
  printf 'usage: %s <bot|speck|glorb> [--since DUR] [--input FILE|-] [--verbose]\n' "${0##*/}" >&2
}

SERVICE=''
SINCE=''
INPUT=''
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --since)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then usage; exit 3; fi
      SINCE="$2"
      shift 2
      ;;
    --input)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then usage; exit 3; fi
      INPUT="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf 'ERROR: unknown option: %s\n' "$1" >&2
      usage
      exit 3
      ;;
    *)
      if [ -n "$SERVICE" ]; then
        printf 'ERROR: usage: only one service allowed (got %s and %s)\n' "$SERVICE" "$1" >&2
        exit 3
      fi
      SERVICE="$1"
      shift
      ;;
  esac
done

# Service allowlist = the exact compose service names (docker-compose.yml).
case "$SERVICE" in
  bot|speck|glorb) ;;
  *)
    printf 'ERROR: usage: service must be bot|speck|glorb (got: %s)\n' "${SERVICE:-<none>}" >&2
    exit 3
    ;;
esac

if [ -n "$SINCE" ]; then
  # Deliberately permissive (a bare duration-shaped token); docker compose is
  # the real validator and a compose rejection exits 4 per the contract.
  if ! [[ "$SINCE" =~ ^[0-9][0-9a-zA-Z.]*$ ]]; then
    printf 'ERROR: usage: --since wants a duration like 10m or 2h (got: %s)\n' "$SINCE" >&2
    exit 3
  fi
fi

# ---------------------------------------------------------------------------
# Signature tables — every fixed string grepped from its emit site in this
# repo (re-verified against the tree at implementation time; citations are
# file:line of the emitting console.* call).
# ---------------------------------------------------------------------------

# CRASH signatures (exit 1). Case-sensitive fixed strings:
CRASH_SIGS=(
  '[resilience] unhandled rejection:'    # service/resilience.js:117
  '[resilience] uncaught exception:'     # service/resilience.js:127
  '[resilience] client error event:'     # service/resilience.js:111
  'UnhandledPromiseRejection'            # Node process dump (Node 18 default
                                         # --unhandled-rejections=throw; CRASH_REPORT.md)
  'OOMKilled'                            # docker inspect .State.OOMKilled (live
                                         # probe below) + literal in fixture text (--input)
  'Fatal Error:'                         # index.js:495
  'Error registering commands:'          # index.js:124
  'Error in valheimServer()'             # index.js:392
  'turnOnVpn failed'                     # index.js:324
  'whatsMyIp failed'                     # index.js:342
  'interaction handler error'            # index.js:691
  'Error:'                               # generic thrown-Error dump (stack lines)
)
# Case-insensitive crash catch-alls (lowercased line vs lowercase pattern):
#   unhandledRejection    — card-mandated catch-all (process event name)
#   unhandled promise     — card-mandated catch-all (Node dump prose)

# MEMORY-DEGRADED signatures (exit 2 when crash count == 0). Case-sensitive:
MEM_SIGS=(
  'AI: memory disabled (aiMemoryEnabled=false)'   # index.js:197
  'AI: memory unavailable — '                     # index.js:201 (interpolates the
                                                  # reason — see precedence rule)
  'AI: could not verify chat model at startup:'   # index.js:156,172
  'AI: chat model check FAILED'                   # index.js:153,169
  'sushi verifyModelId: /models unreachable'      # service/ai/sushiClient.js:311
  'MEMORY: FTS5 probe failed'                     # service/ai/memory/memoryManager.js:75
  'MEMORY: embedding dimension check failed'      # service/ai/memory/embedder.js:172
  'AI: memory retrieve failed, continuing without it:'  # service/ai/memory/memoryManager.js:178
  'AI: memory ingest failed:'                     # service/ai/memory/memoryManager.js:301
  'AI: memory re-embed refused for'               # service/ai/memory/memoryManager.js:435
)

# CLEAN evidence (informational only — clean = no crash AND no degraded):
#   Ready!                                          index.js:229 (may carry a
#                                                   ` [speck chat-only]`-style tag)
#   Build time:                                     index.js:230
#   AI: memory ready —                              index.js:206
#   AI: image descriptions ready —                  index.js:224
#   requestLog: conversation log for this bot ->    index.js:233
CLEAN_SIGS=(
  'Ready!'
  'Build time:'
  'AI: memory ready — '
  'AI: image descriptions ready — '
  'requestLog: conversation log for this bot -> '
)

classify_line() {  # $1=line $2=lineno — updates CRASH/DEGRADED, never aborts
  local line="$1" lineno="$2" sig lc
  # 1. memory-degraded FIRST: the interpolated-reason precedence rule.
  for sig in "${MEM_SIGS[@]}"; do
    case "$line" in
      (*"$sig"*)
        DEGRADED=$((DEGRADED + 1))
        if [ "$VERBOSE" = 1 ]; then printf 'MATCH memory-degraded %d: %s\n' "$lineno" "$line"; fi
        return 0
        ;;
    esac
  done
  # 2. crash signatures (two catch-alls matched case-insensitively).
  lc="$(printf '%s' "$line" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  for sig in "${CRASH_SIGS[@]}"; do
    case "$line" in
      (*"$sig"*)
        CRASH=$((CRASH + 1))
        if [ "$VERBOSE" = 1 ]; then printf 'MATCH crash %d: %s\n' "$lineno" "$line"; fi
        return 0
        ;;
    esac
  done
  case "$lc" in
    (*unhandledrejection*|*"unhandled promise"*)
      CRASH=$((CRASH + 1))
      if [ "$VERBOSE" = 1 ]; then printf 'MATCH crash %d: %s\n' "$lineno" "$line"; fi
      return 0
      ;;
  esac
  # 3. neither bucket: informational. --verbose may note clean evidence only.
  if [ "$VERBOSE" = 1 ]; then
    for sig in "${CLEAN_SIGS[@]}"; do
      case "$line" in
        (*"$sig"*)
          printf 'INFO clean-evidence %d: %s\n' "$lineno" "$line"
          break
          ;;
      esac
    done
  fi
  return 0
}

emit_verdict() {  # the one-line stdout contract (see header)
  if [ "$CRASH" -gt 0 ]; then
    printf 'VERDICT=crash count=%d\n' "$CRASH"
    exit 1
  fi
  if [ "$DEGRADED" -gt 0 ]; then
    printf 'VERDICT=memory-degraded count=%d\n' "$DEGRADED"
    exit 2
  fi
  printf 'VERDICT=clean count=0\n'
  exit 0
}

CRASH=0
DEGRADED=0
LINENO_=0

if [ -n "$INPUT" ]; then
  # ---- docker-free mode (the unit-test seam) ------------------------------
  if [ "$INPUT" != '-' ] && [ ! -f "$INPUT" ]; then
    printf 'ERROR: --input file not readable: %s\n' "$INPUT" >&2
    exit 3
  fi
  if [ "$INPUT" = '-' ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      LINENO_=$((LINENO_ + 1))
      classify_line "$line" "$LINENO_"
    done
  else
    while IFS= read -r line || [ -n "$line" ]; do
      LINENO_=$((LINENO_ + 1))
      classify_line "$line" "$LINENO_"
    done < "$INPUT"
  fi
  emit_verdict
fi

# ---- live mode: docker is a hard dependency (contract exit 4) -------------
if ! command -v docker >/dev/null 2>&1; then
  printf 'ERROR: docker not found (run on the deploy host, or use --input)\n' >&2
  exit 4
fi
LOGS=''
if [ -n "$SINCE" ]; then
  # DUR passes through VERBATIM — docker compose rejects garbage (exit 4).
  LOGS="$(docker compose logs --since "$SINCE" "$SERVICE" 2>/dev/null)" \
    || { printf 'ERROR: docker compose logs --since %s %s failed\n' "$SINCE" "$SERVICE" >&2; exit 4; }
else
  LOGS="$(docker compose logs "$SERVICE" 2>/dev/null)" \
    || { printf 'ERROR: docker compose logs %s failed\n' "$SERVICE" >&2; exit 4; }
fi
while IFS= read -r line || [ -n "$line" ]; do
  LINENO_=$((LINENO_ + 1))
  classify_line "$line" "$LINENO_"
done <<< "$LOGS"

# Live-only inspect probe: OOMKilled and RestartCount>0 are container STATE,
# not log text — they cannot be text signatures, so probe them directly
# (each counts as one crash hit). Any inspect hiccup must never abort; the
# VERDICT still emits from the text classification above.
cid="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
if [ -n "$cid" ]; then
  state="$(docker inspect -f '{{.State.OOMKilled}} {{.State.RestartCount}}' "$cid" 2>/dev/null || true)"
  if [ -n "$state" ]; then
    # shellcheck disable=SC2086  # deliberate 2-word split: "<OOMKilled> <RestartCount>"
    set -- $state
    if [ "$1" = 'true' ]; then
      CRASH=$((CRASH + 1))
      if [ "$VERBOSE" = 1 ]; then printf 'MATCH crash inspect: OOMKilled=true\n'; fi
    fi
    if [ "${2:-0}" -gt 0 ] 2>/dev/null; then
      CRASH=$((CRASH + 1))
      if [ "$VERBOSE" = 1 ]; then printf 'MATCH crash inspect: RestartCount=%s\n' "$2"; fi
    fi
  fi
fi

emit_verdict
