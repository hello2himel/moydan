# Releases

Everything below is built on one machine, from this repository, with no external CI. The
build scripts are in the repository so the same thing happens for anyone who clones it.

```bash
node scripts/release.mjs --tag v0.1.0          # everything
node scripts/release.mjs --only android        # one target
node scripts/release.mjs --only windows
node scripts/release.mjs --only linux
node scripts/release.mjs --only flatpak
```

Artefacts land in `dist-release/` with a `SHA256SUMS` file and generated release notes.
Nothing is uploaded automatically: publishing is a separate, explicit
`gh release create` step, so a failed build can never publish a broken artefact.

## What is built

| Target | Output | How |
| --- | --- | --- |
| Web | `apps/web/dist/` | Vite production build |
| Linux | `Moydan-<v>-x86_64-linux.tar.gz` | Tauri binary + desktop entry |
| Windows | `Moydan-<v>-x64-windows.zip` | Tauri cross-compiled with `cargo xwin`, portable `Moydan.exe` |
| Android | `Moydan-<v>-android-universal.apk` | Gradle `assembleRelease`, WebView shell |
| Flatpak | `Moydan-<v>-x86_64.flatpak` | low-level `flatpak build` + `build-bundle` |

## Desktop (Tauri)

`apps/desktop/src-tauri` builds one Rust binary that contains the whole client:

- **Local mode** (default): it starts the platform on the machine it runs on — the API
  process (which also serves the web app), the game origin on a second origin, and the
  build worker — and then loads `http://127.0.0.1:<port>`. Data lives in the OS
  application-data directory; session and worker secrets are generated on first run.
- **Deployment mode**: set `MOYDAN_SERVER_URL` (or `serverUrl` in `desktop.json`) and the
  shell simply points at that deployment.

`scripts/build-desktop.mjs` stages what the binary needs:

1. `server/` — the API, game origin and worker bundled from TypeScript, with every
   third-party package left external.
2. `node_modules/` — the transitive closure those servers resolve at run time.
3. `node/` — a Node.js runtime for the *target* platform, because a Tauri binary ships
   no Node of its own.
4. `web/` — the production web build.

The target-specific esbuild binary is fetched for the target platform, so a Linux machine
can produce a Windows build that can actually compile games.

```bash
node scripts/build-desktop.mjs --platform linux   # or win
cargo build --release                            # Linux
cargo xwin build --release --target x86_64-pc-windows-msvc   # Windows
```

Icons are generated, not committed as opaque binaries:
`node scripts/generate-icons.mjs` writes the PNG/ICO set for Android, Tauri and the
desktop packages.

## Android

`apps/android` is a dependency-free WebView shell (no AndroidX, no Capacitor) so the APK
stays at ~20 kB and has an empty supply chain.

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export JAVA_HOME=/path/to/jdk21                # Gradle 8.14 does not run on Java 27
apps/android/gradlew assembleRelease           # or: gradle assembleRelease
```

The server address is chosen on first launch and stored locally; cleartext HTTP is
refused except for loopback. The release APK is signed with
`apps/android/keystore/moydan-release.jks` when that file exists (set
`MOYDAN_KEYSTORE_PASSWORD`, `MOYDAN_KEY_ALIAS`, `MOYDAN_KEY_PASSWORD`), otherwise it
falls back to the debug key so the artefact is always installable.

## Flatpak

```bash
flatpak install --user flathub org.gnome.Sdk//48
node scripts/release.mjs --only linux          # produces the Tauri binary first
packaging/flatpak/build-flatpak.sh
```

`build-flatpak.sh` uses `flatpak build` / `build-export` / `build-bundle` directly, so
flatpak-builder is not required. The package bundles the same Tauri binary, grants only
`--share=network` and the usual display sockets, and uses the GNOME 48 runtime for
WebKitGTK.

## Publishing

```bash
git tag v0.1.0 && git push origin main --tags
gh release create v0.1.0 dist-release/* \
  --title "Moydan 0.1.0" --notes-file dist-release/RELEASE-NOTES.md
```

## Verifying a download

```bash
sha256sum -c SHA256SUMS
```
