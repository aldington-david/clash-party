# Clash Party with AnyTLS + REALITY

This is a custom build of mihomo-party-org/clash-party, not an official release.
It uses only aldington-david/mihomo stable releases with the AnyTLS + REALITY patch.

The `anytls-reality` default branch owns the automation and `.anytls/client.patch`.
Every hour at minute 27 (UTC), or on manual dispatch, the workflow checks the latest
non-prerelease upstream app and custom core releases. A change in either creates
`APP_TAG-anytls-CORE_TAG`. Existing public releases are never replaced.

The workflow checks out the exact upstream app tag, applies the patch with
`git apply --check`, pins the core tag, and pushes a source tag containing the
patched tree and `.anytls-build.json`. A patch conflict fails the workflow and
requires updating the patch. Build failures leave only the source tag for retries;
a public Release appears only after all six installers are built and checked.

Only Linux amd64/arm64 DEB, macOS arm64/x64 PKG, Windows x64 NSIS and Win7 x64 NSIS
installers are published, plus `latest.yml`, `checksums.sha256`, and provenance.
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
Application updates use this repository's Releases and validate download hashes.
An update with the same upstream app version but a newer core does not trigger
the upstream app-version comparator; download that installer manually or update
the core in the app. Linux uses manual DEB installation as upstream does.

No PAT, code-signing credential, or cross-repository write permission is needed:
the workflow uses its own repository's `GITHUB_TOKEN` with `contents: write`.
GitHub may delay cron jobs. A monthly empty control-branch commit keeps the public
repository active so the scheduled workflow is not disabled for inactivity.

Run `python .anytls/check.py` to check fork sources and release input validation.
The production app is never run by these checks.
