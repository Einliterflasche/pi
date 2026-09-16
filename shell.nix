{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24
    just
    git
    python3
    pkg-config
    gnumake
    ripgrep
    fd
  ];

  shellHook = ''
    stamp=node_modules/.package-lock.stamp
    if [ ! -d node_modules ] || ! cmp -s package-lock.json "$stamp"; then
      echo "shell.nix: package-lock.json changed, running npm ci --ignore-scripts..."
      npm ci --ignore-scripts && cp package-lock.json "$stamp"
    fi
  '' + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
    # Biome's static musl binary runs on NixOS without a system ELF interpreter.
    export BIOME_BINARY="@biomejs/cli-linux-${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}-musl/biome"
  '';
}
