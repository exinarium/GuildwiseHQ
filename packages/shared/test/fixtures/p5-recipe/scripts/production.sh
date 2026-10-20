#!/usr/bin/env bash
set -euo pipefail
test "${AOM_DEPLOY_DRY_RUN:-0}" = 1 && { echo "dry run: would deploy to production"; exit 0; }
echo "production deploy of ${AOM_DEPLOY_COMMIT:-?} with key length ${#P5_PROD_DEPLOY_KEY}"
