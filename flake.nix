{
  description = "Development environment with Google Apps Script CLI (clasp)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.google-clasp
            pkgs.nodejs
          ];

          shellHook = ''
            echo "Google Apps Script CLI (clasp) environment loaded."
            echo "clasp version: $(clasp --version 2>/dev/null || echo 'available')"
          '';
        };
      });
}
