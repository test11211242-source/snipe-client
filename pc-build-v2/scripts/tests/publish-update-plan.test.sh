#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$SCRIPT_DIR/../../publish-update.sh"

output="$($PUBLISHER release --plan)"
value() {
  local label="$1"
  while IFS= read -r line; do
    if [[ "$line" == "$label: "* ]]; then
      printf '%s' "${line#*: }"
      return
    fi
  done <<<"$output"
  return 1
}

mode="$(value Mode)"
package_version="$(value 'Package version')"
published_version="$(value 'Published version')"
selected_version="$(value 'Selected version')"
bootstrap="$(value Bootstrap)"

[[ "$mode" == release ]]
for version in "$package_version" "$selected_version"; do
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
done

comparison="$(node -e '
  const [left, right] = process.argv.slice(1).map((value) => value.split(".").map(BigInt));
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      process.stdout.write(left[index] > right[index] ? "1" : "-1");
      process.exit(0);
    }
  }
  process.stdout.write("0");
' "$selected_version" "$package_version")"
((comparison >= 0))

if [[ "$published_version" == none ]]; then
  [[ "$bootstrap" == true ]]
  [[ "$selected_version" == "$package_version" ]]
else
  [[ "$published_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
  [[ "$bootstrap" == false ]]
fi

printf 'Publisher plan tests passed.\n'
