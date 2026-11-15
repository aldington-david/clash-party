# Clash Party with AnyTLS + REALITY

This is a custom build of mihomo-party-org/clash-party, not an official release.
It uses only aldington-david/mihomo stable releases with the AnyTLS + REALITY patch.

The `anytls-reality` default branch owns the automation and `.anytls/client.patch`.
Every hour at minute 27 (UTC), or on manual dispatch, the workflow checks the latest
non-prerelease upstream app and custom core releases. A change in either creates
`APP_TAG-anytls-CORE_TAG-r4`. Existing public releases are never replaced.

The workflow checks out the exact upstream app tag, applies the patch with
`git apply --check`, pins the core tag, and pushes a source tag containing the
patched tree and `.anytls-build.json`. A patch conflict fails the workflow and
requires updating the patch. Build failures leave only the source tag for retries;
a public Release appears only after all six installers are built and checked.
Repository URLs are replaced separately with exact occurrence checks, so UI
layout changes do not invalidate URL-only edits. Structural patches remain strict.
Unpublished tags must match the current source recipe fingerprint before reuse;
an outdated tag stops with an explicit recovery message instead of rebuilding old
sources. Published releases are never rebuilt by this maintenance check.

Only Linux amd64/arm64 DEB, macOS arm64/x64 PKG, Windows x64 NSIS and Win7 x64 NSIS
installers are published, each with a matching `<installer>.sha256` file, plus
`latest.yml`, `checksums.sha256`, and provenance: fifteen assets in total.
The sidecar files serve installed clients when the GitHub asset-digest API is
unavailable. They use the same installer hashes as the combined checksum list;
the list also covers the sidecars. The r2 suffix publishes this metadata repair
without replacing the earlier app/core release. Installer names and app-version
comparison stay unchanged, so an app already at the same version still uses the
manual-download or in-app core-update paths described below.
The macOS apps use ad-hoc signing; PKGs are unsigned and not notarized. Windows
installers are unsigned. No upstream signing identity or certificates are used.
Win7 follows upstream's Electron 22.3.27/CommonJS/sysproxy setup and uses the custom
`*-go120-*` core. Producing that installer does not certify it on Windows 7 hardware.

Bundled cores are pinned and their archives checked against the core release's
`sha256sum.txt`. Alpha and Smart cores are disabled. The specific-version picker
uses the custom core repository and a separate filename, so old official specific
cores are not reused. The core's own updater must also point at the custom repo.
Specific-version downloads may use the configured mirror, but their hashes must
match the checksum manifest fetched directly from the custom GitHub release.
Source checks cover tracked application/build code, including newly added files.
The only official-release URL exceptions are the existing LightGBM model-data
URL and the upstream release-note/Telegram helper literals, which this workflow
does not invoke. Geography, theme, and other resource repositories remain allowed.
Application updates use this repository's Releases and validate download hashes.
An update with the same upstream app version but a newer core does not trigger
the upstream app-version comparator; download that installer manually or update
the core in the app. Linux uses manual DEB installation as upstream does.

No PAT, code-signing credential, or cross-repository write permission is needed:
the workflow uses its own repository's `GITHUB_TOKEN` with `contents: write`.
GitHub may delay cron jobs. A monthly empty control-branch commit keeps the public
repository active so the scheduled workflow is not disabled for inactivity.

Run `python .anytls/check.py` to check fork sources and release input validation.
Run `python .anytls/test_release.py` for offline rejection tests, including stale
recipes, unexpected downloads, mismatched build provenance, and incomplete drafts.
The structural patches currently target official v2.0.4. To check a fetched
upstream commit before publishing, run `python .anytls/test_overlay_replay.py <ref>`.
The build also runs `node .anytls/test_source_compat.mjs` against the patched tree:
it checks mode migration and persistence, Electron 22 IPC ownership/cleanup, and
the upstream one-time first-content signal without launching Electron.
The production app is never run by these checks.

## Initial settings in revision 3

`default-settings.patch` follows the existing client patch. It changes the sixteen
approved parameters: silent startup on; tray proxy information off; Sub-Store off;
automatic connection closing off; detailed proxy information; subscription update
dates; hidden DNS and sniff cards; above-normal Windows core priority; PAC mode;
TCP concurrency and Geo updates on; silent runtime logs; Mips TUN stack; strict
routing on; and client sniff overriding off. DNS overriding remains off. With
both override controls off, subscriptions retain their DNS, hosts and sniff settings.

The connection view remains a list in ascending order, LAN access remains off,
and kernel IPv6 remains on. TUN and system proxy remain off until manually enabled.
The platform-specific TUN device names and proxy bypass lists are unchanged.
Explicit saved settings retain priority over the new defaults.

HomoHub CSS is bundled offline and becomes the default theme. Basic initialization
copies it before the first window render only when the user's theme file is absent;
existing same-name CSS is retained. Development resolves the tracked source asset,
while packaged builds use the bundled resource. CI exercises both paths and checks
the theme in all six packaged applications before installer publication.

## New subscription schedules in revision 4

New remote subscriptions keep automatic updates enabled and use a fixed 360-minute
interval. Their first response cannot replace that default with the server's
suggested interval. Existing subscriptions retain their stored switch, interval
and choice to follow server recommendations; local files retain their old behavior.
New plugin subscriptions also default to 360 minutes with updates enabled.
The existing application startup, interval and Cron scheduling paths remain unchanged.
