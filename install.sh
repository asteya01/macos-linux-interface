#!/usr/bin/env bash
# Installs all of my GNOME extensions from the extensions/ folder.
# Usage:  ./install.sh
# Then log out and back in, and enable them (see README).
set -euo pipefail

cd "$(dirname "$0")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for dir in extensions/*/; do
    uuid="$(basename "$dir")"
    echo "Installing $uuid"
    gnome-extensions pack "$dir" --force --out-dir "$tmp"
    gnome-extensions install --force "$tmp/$uuid.shell-extension.zip"
done

echo
echo "Done. Log out and back in, then enable the ones you want, for example:"
echo "  gnome-extensions enable dynamic-island@asteya"
