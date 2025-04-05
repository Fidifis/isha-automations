# What are Nix Flakes https://www.tweag.io/blog/2020-05-25-flakes/
{
  description = "A very basic flake for infra development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils}:
    flake-utils.lib.eachDefaultSystem(system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        buildZippedGoBinary = name: srcPath: pkgs.buildGoModule {
          pname = "${name}";
          version = "1.0.0";
          src = ./code/${srcPath};

          vendorHash = "sha256-829Coow/8VuIU6V37IBld8WWvtEIvK0VpWldgWJH1jA=";

          nativeBuildInputs = [ pkgs.zip ];
          postInstall = ''
            mkdir -p $out/lib
            zip -j $out/lib/${name}.zip $out/bin/*
          '';
          
        };
      in rec
      {
        packages = {
          authorizerLambda = buildZippedGoBinary "authorizer" "authorizer";

          default = pkgs.stdenv.mkDerivation {
            pname = "isha-lambda-pack";
            version = "1.0.0";

            dontUnpack = true;

            installPhase = ''
              mkdir -p $out
              cp ${packages.authorizerLambda}/lib/authorizer.zip $out/
            '';
          };

        };

        # This is how to do formatter, but I don't like the style
        # formatter = pkgs.nixfmt-rfc-style;

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
