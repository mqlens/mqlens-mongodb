{ autoPatchelfHook
, dpkg
, fetchurl
, glib-networking
, gtk3
, krb5
, lib
, libgpg-error
, libsecret
, stdenv
, webkitgtk_4_1
, wrapGAppsHook3
}:

assert stdenv.hostPlatform.system == "x86_64-linux";

let
  release = builtins.fromJSON (builtins.readFile ./release.json);
  pname = "mqlens";
  version = release.version;
  src = fetchurl {
    url = "https://github.com/mqlens/mqlens-mongodb/releases/download/mqlens-v${version}/MQLens_${version}_amd64.deb";
    hash = release.hash;
  };
in
stdenv.mkDerivation {
  inherit pname version src;

  dontUnpack = true;

  nativeBuildInputs = [
    autoPatchelfHook
    dpkg
    wrapGAppsHook3
  ];

  buildInputs = [
    glib-networking
    gtk3
    krb5
    libgpg-error
    libsecret
    webkitgtk_4_1
  ];

  installPhase = ''
    runHook preInstall

    dpkg-deb --extract "$src" "$TMPDIR/mqlens-deb"
    install -Dm755 "$TMPDIR/mqlens-deb/usr/bin/MQLens" "$out/bin/mqlens"
    install -Dm644 "$TMPDIR/mqlens-deb/usr/share/applications/MQLens.desktop" \
      "$out/share/applications/mqlens.desktop"
    substituteInPlace "$out/share/applications/mqlens.desktop" \
      --replace-fail 'Exec=MQLens' 'Exec=mqlens' \
      --replace-fail 'Icon=MQLens' 'Icon=applications-development' \
      --replace-fail 'Categories=' 'Categories=Development;Database;'

    runHook postInstall
  '';

  meta = {
    description = "A native desktop GUI for MongoDB";
    homepage = "https://mqlens.com";
    license = lib.licenses.asl20;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
