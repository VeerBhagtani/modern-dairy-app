#!/usr/bin/env bash
# Publish the office dashboard and the driver APK to Firebase Hosting, in the
# company's own Google project: https://<project>.web.app
#
# The same files GitHub Pages serves (the gh-pages branch: the dashboard with
# its scripts stamped, plus modern-drivers.apk), at an address with no
# github.io and no personal account name in it.
#
# Usage: scripts/publish-hosting.sh <project-id>
# Needs: GOOGLE_APPLICATION_CREDENTIALS, GITHUB_TOKEN, GITHUB_REPOSITORY.
set -euo pipefail
P="$1"
URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
rm -rf site
git clone -q --depth 1 --branch gh-pages "$URL" site
rm -rf site/.git
npx --yes firebase-tools@13 deploy --only hosting --project "$P" --config firebase-hosting.json \
  --non-interactive --message "from ${GITHUB_SHA::7}"
{
  echo "## Published at https://${P}.web.app"
  echo
  echo "Driver app: https://${P}.web.app/modern-drivers.apk"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
