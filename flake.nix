{
  description = "MQLens for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      mqlens = pkgs.callPackage ./nixos/package.nix { };
    in
    {
      packages.${system} = {
        default = mqlens;
        inherit mqlens;
      };

      nixosModules.default = import ./nixos/module.nix;
    };
}
