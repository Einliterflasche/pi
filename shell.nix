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
}
