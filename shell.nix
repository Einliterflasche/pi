{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    just
    git
    python3
    pkg-config
    gnumake
  ];

  shellHook = ''
    stamp=node_modules/.package-lock.stamp
    if [ ! -d node_modules ] || ! cmp -s package-lock.json "$stamp"; then
      echo "shell.nix: package-lock.json changed, running npm ci..."
      npm ci && cp package-lock.json "$stamp"
    fi
  '';
}
