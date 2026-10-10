#!/usr/bin/env bash
# Reproduce the Linux x86_64 driver used by cloud development and CI.
set -euo pipefail
if [[ "$(uname -sm)" != "Linux x86_64" ]]; then
  printf '%s\n' 'Install geckodriver 0.37.1 for your platform and set GECKODRIVER_PATH.' >&2
  exit 1
fi
destination=${1:?Usage: bash scripts/install-geckodriver.sh DESTINATION_DIRECTORY}
archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz \
  --output "$archive_dir/geckodriver.tar.gz"
# SHA-256 of the pinned archive retrieved from Mozilla's official release.
printf '%s  %s\n' \
  e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e \
  "$archive_dir/geckodriver.tar.gz" | sha256sum --check
tar -xzf "$archive_dir/geckodriver.tar.gz" -C "$archive_dir" geckodriver
mkdir -p "$destination"
install -m 755 "$archive_dir/geckodriver" "$destination/geckodriver"
"$destination/geckodriver" --version
