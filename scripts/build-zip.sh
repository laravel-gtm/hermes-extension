#!/usr/bin/env bash
#
# Package the extension for distribution.
# Produces dist/hermes-extension-v<version>.zip with manifest.json at the zip root,
# so unzipping gives a folder Chrome can "Load unpacked" directly.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/extension"
version="$(python3 -c "import json; print(json.load(open('$src/manifest.json'))['version'])")"
pkg_version="$(python3 -c "import json; print(json.load(open('$repo_root/package.json'))['version'])")"

if [[ "$version" != "$pkg_version" ]]; then
  echo "Version mismatch: extension/manifest.json ($version) != package.json ($pkg_version)" >&2
  exit 1
fi

out_dir="$repo_root/dist"
out="$out_dir/hermes-extension-v$version.zip"

mkdir -p "$out_dir"
rm -f "$out"

(
  cd "$src"
  zip -r "$out" . \
    -x "*.py" \
    -x "*/.DS_Store" -x ".DS_Store" \
    -x "*/__pycache__/*"
)

echo "Built $out"
unzip -l "$out"
