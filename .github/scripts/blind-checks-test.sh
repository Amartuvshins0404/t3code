#!/usr/bin/env bash
set -euo pipefail

browser=false
desktop=false
for arg in "$@"; do
  [[ "$arg" == *.browser.test.* ]] && browser=true
  [[ "$arg" == apps/desktop/* ]] && desktop=true
done

if [[ "$browser" == true && ! -e "$RUNNER_TEMP/chromium-installed" ]]; then
  node apps/web/node_modules/playwright/cli.js install --only-shell chromium
  node apps/web/node_modules/playwright/cli.js install-deps chromium
  touch "$RUNNER_TEMP/chromium-installed"
fi

if [[ "$desktop" == true ]]; then
  vp run --filter @t3tools/desktop ensure:electron
fi

exec vp test run "$@"
