# What are Nix Flakes https://www.tweag.io/blog/2020-05-25-flakes/
{
  description = "A very basic flake for infra development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
      in {
        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            pulumi
            pulumiPackages.pulumi-language-nodejs
            nodejs
            go
            dotnet-sdk
          ];
        };
      }
    );
}
