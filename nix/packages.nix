# All Spencer build outputs for one system.
{
  lib,
  pkgs,
  src,
}:
let
  nodejs = pkgs.nodejs_22;
  croc = pkgs.callPackage ./croc.nix { };
  version = (lib.importJSON ../packages/spencer/package.json).version;

  # The whole npm workspace: production node_modules plus the TypeScript sources
  # (Node >= 22.18 runs them directly via type stripping) and the bundled relay.
  workspace = pkgs.buildNpmPackage {
    pname = "spencer-workspace";
    inherit version src nodejs;
    npmDepsHash = "sha256-AGvGh7OoB/KWSY8pr6cHidagvPaK9O2lXyVVOmHBLpI=";
    # Install scripts are not needed (esbuild finds its platform binary package directly).
    npmFlags = [ "--ignore-scripts" ];
    npmBuildScript = "build:relay";
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts --offline
      node -e 'const m = { exports: {} }; process.dlopen(m, require.resolve("@node-datachannel/" + process.platform + "-" + process.arch + (process.platform === "linux" ? "-gnu" : "")));'
      # Build-only tools that prune leaves behind in a workspace (the native tsc alone is ~100 MB).
      rm -rf node_modules/{typescript,@typescript,esbuild,@esbuild,@types} node_modules/.bin
      mkdir -p $out/lib/spencer
      cp -r package.json packages node_modules $out/lib/spencer/
      install -Dm0644 dist/relay/relay.mjs $out/lib/spencer/dist/relay/relay.mjs
      rm -rf $out/lib/spencer/packages/*/test $out/lib/spencer/packages/web/dev
      runHook postInstall
    '';
    dontNpmInstall = true;
  };

  spencer =
    pkgs.runCommand "spencer-${version}"
      {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta = {
          description = "Spencer daemon: agent, peer messaging, croc file transfers and local web UI";
          mainProgram = "spencer";
          platforms = lib.platforms.unix;
        };
        passthru = { inherit workspace croc nodejs; };
      }
      ''
        makeWrapper ${lib.getExe nodejs} $out/bin/spencer \
          --set-default SPENCER_BUILD "${version}" \
          --run 'export SPENCER_BIN="''${SPENCER_BIN:-$0}"' \
          --add-flags "--disable-warning=ExperimentalWarning" \
          --add-flags "${workspace}/lib/spencer/packages/spencer/src/main.ts" \
          --prefix PATH : ${lib.makeBinPath [ croc ]}
      '';

  # The relay is a single bundled file: tiny closure, suitable for a small VPS.
  spencer-relay =
    pkgs.runCommand "spencer-relay-${version}"
      {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta = {
          description = "Spencer message relay (ciphertext-only mailbox and forwarder)";
          mainProgram = "spencer-relay";
          platforms = lib.platforms.unix;
        };
      }
      ''
        install -Dm0644 ${workspace}/lib/spencer/dist/relay/relay.mjs $out/lib/spencer-relay/relay.mjs
        makeWrapper ${lib.getExe nodejs} $out/bin/spencer-relay \
          --add-flags "--disable-warning=ExperimentalWarning" \
          --add-flags "$out/lib/spencer-relay/relay.mjs"
      '';

  # Static web UI (served by the daemon; also usable on its own with a reverse proxy in front of a daemon).
  spencer-web = pkgs.runCommand "spencer-web-${version}" { } ''
    mkdir -p $out/share/spencer-web
    cp -r ${workspace}/lib/spencer/packages/web/public/. $out/share/spencer-web/
  '';
in
{
  inherit
    spencer
    spencer-relay
    spencer-web
    croc
    workspace
    ;
}
