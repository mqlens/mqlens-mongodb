{ config, lib, pkgs, ... }:

let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.programs.mqlens;
in
{
  options.programs.mqlens = {
    enable = mkEnableOption "MQLens MongoDB desktop application";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The MQLens package to install.";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ cfg.package pkgs.mongosh ];
  };
}
