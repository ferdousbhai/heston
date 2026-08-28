#!/usr/bin/env bash
set -euo pipefail

# readlink rather than cd+pwd: a cd hook that echoes the directory would end up in the link target.
unit_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$target_dir"
for unit in spice-catalyst-research.service spice-catalyst-research.timer; do
  ln -sfn "$unit_dir/$unit" "$target_dir/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now spice-catalyst-research.timer
systemctl --user list-timers spice-catalyst-research.timer --no-pager
