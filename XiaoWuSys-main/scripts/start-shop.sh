#!/usr/bin/env bash
# Starts XiaoMei ERP on the shop computer (macOS / Linux): the Express API (port 5000) and the
# Next.js screens (port 3000), waits until both answer, then opens http://localhost:3000.
#
# Both servers listen on 0.0.0.0, so tablets on the shop Wi-Fi can open
# http://<shop-computer-ip>:3000 (add that address to CORS_ORIGINS in Backend/.env).
# Press Ctrl+C to stop both servers.
#
# Usage:  scripts/start-shop.sh [--demo] [--rebuild] [--no-browser]
#   --demo        no cloud database needed (Backend "npm run demo", sample data on this computer)
#   --rebuild     rebuild the Next.js app first (run this after updating the code)
#   --no-browser  do not open the browser
# First time on a computer: (cd Backend && npm ci) and (cd Web && npm ci).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT/Backend"
WEB_DIR="$ROOT/Web"
API_STATUS_URL="http://127.0.0.1:5000/api/status"
WEB_URL="http://127.0.0.1:3000"
OPEN_URL="http://localhost:3000"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"
# The Next.js process must never see these (Web/next.config.ts refuses to start if it does)
BACKEND_ONLY_ENV=(DATABASE_URL PG_LISTEN_URL JWT_SECRET TEST_DATABASE_URL)

DEMO=0; REBUILD=0; BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    --rebuild) REBUILD=1 ;;
    --no-browser) BROWSER=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

fail() { printf '\n%s\n' "$1" >&2; exit 1; }

# Any HTTP answer (even an error page) proves the server is listening; no answer = not yet
answers() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -L --max-time 5 "$1"
  else
    node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))" "$1"
  fi
}

open_browser() {
  [ "$BROWSER" = 1 ] || return 0
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$OPEN_URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$OPEN_URL"
  else echo "Open $OPEN_URL in your browser."
  fi
}

# --- Checks ---------------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22 or newer, then try again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR is too old. Install Node.js 22 or newer."
for dir in "$BACKEND_DIR" "$WEB_DIR"; do
  [ -d "$dir/node_modules" ] || fail "Packages are missing in $dir. Run there: npm ci"
done
if [ "$DEMO" = 0 ] && [ ! -f "$BACKEND_DIR/.env" ]; then
  fail "Backend/.env is missing. Copy Backend/.env.example to Backend/.env and fill it in, or start with --demo."
fi

API_UP=0; WEB_UP=0
answers "$API_STATUS_URL" && API_UP=1
answers "$WEB_URL" && WEB_UP=1
if [ "$API_UP" = 1 ] && [ "$WEB_UP" = 1 ]; then
  echo "XiaoMei ERP is already running."
  open_browser
  exit 0
fi
[ "$API_UP" = 0 ] || fail "Something is already using port 5000. Close the other XiaoMei window (or the program using that port) and try again."
[ "$WEB_UP" = 0 ] || fail "Something is already using port 3000. Close the other XiaoMei window (or the program using that port) and try again."

# Next.js runs through its own entry point (same as "npm run build" / "npm run start").
NEXT_BIN="$WEB_DIR/node_modules/next/dist/bin/next"
unset_backend_env=()
for name in "${BACKEND_ONLY_ENV[@]}"; do unset_backend_env+=(-u "$name"); done

# --- Build the screens once (production build) ----------------------------------------------
if [ "$REBUILD" = 1 ] || [ ! -f "$WEB_DIR/.next/BUILD_ID" ]; then
  echo "Building the screens (first start or --rebuild); this takes a minute..."
  (cd "$WEB_DIR" && env "${unset_backend_env[@]}" node "$NEXT_BIN" build) || fail "The screens could not be built. See the messages above."
fi

# --- Start both servers -------------------------------------------------------------------
BACKEND_PID=""; WEB_PID=""
stop_all() {
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] || continue
    pkill -TERM -P "$pid" 2>/dev/null || true   # npm's child (node)
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap stop_all EXIT
trap 'exit 130' INT TERM

if [ "$DEMO" = 1 ]; then BACKEND_SCRIPT=demo; else BACKEND_SCRIPT=start; fi
echo "Starting the API on port 5000 (npm run $BACKEND_SCRIPT)..."
(cd "$BACKEND_DIR" && exec npm run "$BACKEND_SCRIPT") &
BACKEND_PID=$!

echo "Starting the screens on port 3000..."
(cd "$WEB_DIR" && exec env "${unset_backend_env[@]}" node "$NEXT_BIN" start -H 0.0.0.0 -p 3000) &
WEB_PID=$!

# --- Wait until both answer -----------------------------------------------------------------
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
API_UP=0; WEB_UP=0
while [ "$API_UP" = 0 ] || [ "$WEB_UP" = 0 ]; do
  kill -0 "$BACKEND_PID" 2>/dev/null || fail "The API stopped while starting. See the messages above (Backend/.env, database address)."
  kill -0 "$WEB_PID" 2>/dev/null || fail "The screens stopped while starting. See the messages above."
  [ "$(date +%s)" -le "$deadline" ] || fail "The system did not answer within $TIMEOUT_SECONDS seconds. See the messages above."
  [ "$API_UP" = 1 ] || { answers "$API_STATUS_URL" && API_UP=1; } || true
  [ "$WEB_UP" = 1 ] || { answers "$WEB_URL" && WEB_UP=1; } || true
  if [ "$API_UP" = 0 ] || [ "$WEB_UP" = 0 ]; then sleep 1; fi
done

printf '\nXiaoMei ERP is ready: %s\n' "$OPEN_URL"
echo "Tablets on the shop Wi-Fi: http://<this-computer-ip>:3000 (see the API messages above for the exact address)."
echo "Keep this terminal open. Press Ctrl+C to stop the system."
open_browser

# Stop both if either one stops
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 2; done
echo "One of the servers stopped. Stopping the other one too." >&2
exit 1
