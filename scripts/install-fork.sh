#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

active_pi="$(command -v pi 2>/dev/null || true)"
if [[ -n "${PI_INSTALL_PREFIX:-}" ]]; then
    install_prefix="$PI_INSTALL_PREFIX"
elif [[ "$active_pi" == */bin/pi ]]; then
    install_prefix="${active_pi%/bin/pi}"
else
    install_prefix="${HOME}/.local"
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-fork-install.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
release_dir="$work_dir/release"
stage_dir="$work_dir/stage"

for package_dir in packages/tui packages/ai packages/agent packages/coding-agent; do
    npm --prefix "$package_dir" run clean
done
npm --prefix packages/tui run build
./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json
npm --prefix packages/agent run build
npm --prefix packages/coding-agent run build

mkdir -p "$release_dir/tarballs"
for package_dir in packages/ai packages/tui packages/agent packages/coding-agent; do
    (cd "$package_dir" && npm pack --json --pack-destination "$release_dir/tarballs" >/dev/null)
done

mkdir -p "$stage_dir"
cp "$release_dir"/tarballs/*.tgz "$stage_dir/"

find_tarball() {
    local pattern="$1"
    local matches=("$stage_dir"/$pattern)
    if [[ ${#matches[@]} -ne 1 || ! -f "${matches[0]}" ]]; then
        echo "Expected exactly one tarball matching $pattern" >&2
        exit 1
    fi
    basename "${matches[0]}"
}

ai_tarball="$(find_tarball 'earendil-works-pi-ai-*.tgz')"
tui_tarball="$(find_tarball 'earendil-works-pi-tui-*.tgz')"
agent_tarball="$(find_tarball 'earendil-works-pi-agent-core-*.tgz')"
cli_tarball="$(find_tarball 'earendil-works-pi-coding-agent-*.tgz')"

cat > "$stage_dir/package.json" <<EOF
{
  "private": true,
  "dependencies": {
    "@earendil-works/pi-ai": "file:./$ai_tarball",
    "@earendil-works/pi-tui": "file:./$tui_tarball",
    "@earendil-works/pi-agent-core": "file:./$agent_tarball",
    "@earendil-works/pi-coding-agent": "file:./$cli_tarball"
  },
  "overrides": {
    "@earendil-works/pi-ai": "file:./$ai_tarball",
    "@earendil-works/pi-tui": "file:./$tui_tarball",
    "@earendil-works/pi-agent-core": "file:./$agent_tarball",
    "@earendil-works/pi-coding-agent": "file:./$cli_tarball"
  }
}
EOF

npm install --prefix "$stage_dir" --omit=dev --ignore-scripts
rm "$stage_dir"/*.tgz

target_dir="$install_prefix/lib/pi-fork"
target_bin="$install_prefix/bin/pi"

install_files() {
    mkdir -p "$install_prefix/lib" "$install_prefix/bin"
    rm -rf "$target_dir"
    cp -R "$stage_dir" "$target_dir"
    rm -f "$target_bin"
    ln -s "../lib/pi-fork/node_modules/.bin/pi" "$target_bin"
}

if [[ (-d "$install_prefix" && -w "$install_prefix") || (! -e "$install_prefix" && -w "$(dirname "$install_prefix")") ]]; then
    install_files
elif command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$install_prefix/lib" "$install_prefix/bin"
    sudo rm -rf "$target_dir"
    sudo cp -R "$stage_dir" "$target_dir"
    sudo rm -f "$target_bin"
    sudo ln -s "../lib/pi-fork/node_modules/.bin/pi" "$target_bin"
else
    echo "Cannot write to $install_prefix and sudo is unavailable." >&2
    echo "Set PI_INSTALL_PREFIX to a writable prefix on PATH." >&2
    exit 1
fi

"$target_bin" --version
echo "Installed fork: $target_bin"
