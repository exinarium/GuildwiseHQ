#!/bin/bash
# Restarts the kept demo server (see README.md) with the mock-runtime UI switched off, on the same database, so the
# screenshots show exactly what a real user sees. Usage: AOM_E2E_DB=... AOM_E2E_PORT=... AOM_E2E_DIR=... bash restart-server.sh
set -e
export NVM_DIR=~/.nvm; . ~/.nvm/nvm.sh >/dev/null
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${AOM_E2E_DIR:-/tmp/aom-e2e}"; PORT="${AOM_E2E_PORT:-4601}"; DB="${AOM_E2E_DB:-aom_e2e}"
pid=$(python3 -c "import json;print(json.load(open('$DIR/pids.json'))['server'])")
kill "$pid" 2>/dev/null || true
sleep 2
cd "$repo"
DATABASE_URL="postgres://aom:aom@127.0.0.1:5433/$DB" AOM_PORT="$PORT" AOM_HOST=127.0.0.1 AOM_PUBLIC_ORIGIN="http://localhost:$PORT" \
AOM_SMTP_URL="${AOM_E2E_SMTP_URL:-smtp://127.0.0.1:1025}" AOM_SERVE_WEB=true AOM_WEB_DIST="$repo/apps/web/dist" AOM_RATE_LIMIT=false \
AOM_TEST_CLOCK=true AOM_ALLOW_LOCAL_REMOTES=true AOM_MOCK_UI=false LOG_LEVEL=info \
  setsid nohup node apps/server/dist/main.mjs >> "$DIR/server.log" 2>&1 &
newpid=$!
python3 - <<P
import json
f='$DIR/pids.json'; d=json.load(open(f)); d['server']=$newpid; json.dump(d,open(f,'w'))
P
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && echo "server up (mock UI off), pid $newpid" && exit 0; sleep 1; done
echo "server did not come up" >&2; exit 1
