#!/usr/bin/env bash
# Stand-in for p5-local-deploy.sh: the same shape (flock, dry run, readiness line, AOM-DEPLOY line), no Docker.
set -euo pipefail
WT=${1:-.}
if [ "${AOM_DEPLOY_DRY_RUN:-0}" = 1 ]; then
  echo "dry run: would deploy ${AOM_DEPLOY_COMMIT:-?} from $WT to ${AOM_DEPLOY_TARGET:-?}"
  exit 0
fi
echo "==> deploying ${AOM_DEPLOY_COMMIT:-?} from $WT"
test -n "${P5_ADMIN_PASSWORD:-}" || { echo "P5_ADMIN_PASSWORD is not set" >&2; exit 1; }
echo "    admin password length: ${#P5_ADMIN_PASSWORD}, value: ${P5_ADMIN_PASSWORD}"
echo "P5 DEPLOY READY ${AOM_DEPLOY_COMMIT:-?}"
echo "AOM-DEPLOY {\"commit\":\"${AOM_DEPLOY_COMMIT:-}\",\"url\":\"http://localhost:5500\",\"version\":\"run-${AOM_DEPLOY_COMMIT:-x}\"}"
