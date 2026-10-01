"""Track upstream stable app/core releases, preserve patched source tags, publish atomically."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'mihomo-party-org/clash-party'
CORE = 'aldington-david/mihomo'


def run(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def api(path):
    request = Request('https://api.github.com/' + path, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def stable_tag(release):
    if not release or release['draft'] or release['prerelease']:
        raise ValueError('A published stable release is required')
    tag = release['tag_name']
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError(f'Unexpected stable version: {tag}')
    return tag


def installers(version):
    return {
        f'clash-party-linux-{version}-amd64.deb',
        f'clash-party-linux-{version}-arm64.deb',
        f'clash-party-macos-{version}-arm64.pkg',
        f'clash-party-macos-{version}-x64.pkg',
        f'clash-party-win7-{version}-x64-setup.exe',
        f'clash-party-windows-{version}-x64-setup.exe',
    }


def output(**values):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as file:
        for key, value in values.items():
            file.write(f'{key}={value}\n')


def prepare():
    repository = os.environ['GITHUB_REPOSITORY']
    app_tag = stable_tag(api(f'repos/{UPSTREAM}/releases/latest'))
    core_tag = stable_tag(api(f'repos/{CORE}/releases/latest'))
    core_ref = api(f'repos/{CORE}/git/ref/tags/{core_tag}')['object']
    while core_ref['type'] == 'tag':
        core_ref = api(f'repos/{CORE}/git/tags/{core_ref["sha"]}')['object']
    assert core_ref['type'] == 'commit'
    core_sha = core_ref['sha']
    release_tag = f'{app_tag}-anytls-{core_tag}'
    release = api(f'repos/{repository}/releases/tags/{release_tag}')
    if release and not release['draft']:
        assert installers(app_tag[1:]) <= {asset['name'] for asset in release['assets']}
        output(build='false')
        return

    core_assets = {asset['name'] for asset in api(f'repos/{CORE}/releases/tags/{core_tag}')['assets']}
    for name in ('linux-amd64-compatible', 'linux-arm64', 'darwin-amd64-compatible',
                 'darwin-arm64', 'windows-amd64-compatible', 'windows-amd64-compatible-go120'):
        extension = 'zip' if name.startswith('windows') else 'gz'
        assert f'mihomo-{name}-{core_tag}.{extension}' in core_assets, name
    assert 'sha256sum.txt' in core_assets

    source = ROOT / 'build-source'
    if source.exists():
        raise RuntimeError('build-source must be a fresh directory')
    existing = run('git', 'ls-remote', '--tags', 'origin', f'refs/tags/{release_tag}')
    if existing:
        run('git', 'fetch', 'origin', f'refs/tags/{release_tag}')
        run('git', 'worktree', 'add', '--detach', str(source), 'FETCH_HEAD')
        info = json.loads((source / '.anytls-build.json').read_text())
        assert info['app_tag'] == app_tag and info['core_tag'] == core_tag
        assert info['core_sha'] == core_sha, 'Core source tag moved; refusing silent replacement'
    else:
        run('git', 'fetch', f'https://github.com/{UPSTREAM}.git', f'refs/tags/{app_tag}')
        upstream_commit = run('git', 'rev-parse', 'FETCH_HEAD')
        run('git', 'worktree', 'add', '--detach', str(source), upstream_commit)
        run('git', 'apply', '--check', str(ROOT / '.anytls/client.patch'), cwd=source)
        run('git', 'apply', str(ROOT / '.anytls/client.patch'), cwd=source)
        shutil.rmtree(source / '.github/workflows')
        shutil.copytree(ROOT / '.github/workflows', source / '.github/workflows')
        shutil.copytree(ROOT / '.anytls', source / '.anytls', ignore=shutil.ignore_patterns('__pycache__'))
        info = {
            'app_repository': UPSTREAM, 'app_tag': app_tag, 'upstream_commit': upstream_commit,
            'core_repository': CORE, 'core_tag': core_tag, 'core_sha': core_sha,
            'release_tag': release_tag,
            'overlay_commit': run('git', 'rev-parse', 'HEAD'),
            'patch_sha256': hashlib.sha256((ROOT / '.anytls/client.patch').read_bytes()).hexdigest(),
            'macos_signing': 'ad-hoc app / unsigned pkg, not notarized',
        }
        (source / '.anytls-build.json').write_text(json.dumps(info, indent=2) + '\n')
        run('python3', '.anytls/check.py', cwd=source)
        run('git', 'add', '-A', cwd=source)
        run('git', '-c', 'user.name=github-actions[bot]', '-c',
            'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            '-c', 'core.hooksPath=/dev/null', 'commit', '-m',
            f'Build {app_tag} with AnyTLS + REALITY {core_tag}', cwd=source)
        run('git', 'push', 'origin', f'HEAD:refs/tags/{release_tag}', cwd=source)
    output(build='true', tag=release_tag, app_tag=app_tag, core_tag=core_tag,
           source_commit=run('git', 'rev-parse', 'HEAD', cwd=source))


def publish():
    tag = os.environ['RELEASE_TAG']
    info = json.loads(run('git', 'show', f'{tag}:.anytls-build.json'))
    version = info['app_tag'][1:]
    directory = ROOT / 'release-assets'
    actual = {p.name for p in directory.iterdir() if p.suffix in ('.deb', '.pkg', '.exe')}
    assert actual == installers(version), (actual, installers(version))
    builds = sorted(directory.glob('core-build-info-*.json'))
    assert len(builds) == 6
    info['source_commit'] = run('git', 'rev-list', '-n', '1', tag)
    info['builds'] = [json.loads(p.read_text()) for p in builds]
    assert all(build['tag'] == info['core_tag'] for build in info['builds'])
    (directory / 'build-info.json').write_text(json.dumps(info, indent=2) + '\n')
    for path in builds:
        path.unlink()
    notes = (f"Upstream: [{info['app_tag']}](https://github.com/{UPSTREAM}/releases/tag/{info['app_tag']})\n\n"
             f"Core: [{info['core_tag']}](https://github.com/{CORE}/releases/tag/{info['core_tag']}); AnyTLS + REALITY enabled.\n\n"
             'Only the six requested installers are built. macOS PKGs are unsigned and not notarized; '
             'no Apple Developer identity is claimed. Windows installers are unsigned. '
             'Win7 uses Electron 22 and the Go 1.20-compatible core; no Windows 7 runtime test was performed.\n\n'
             'Updates come from this fork. An app-only version comparison does not prompt again when only the bundled core changes. '
             'See build-info.json and checksums.sha256 for source and asset provenance.\n')
    (directory / 'latest.yml').write_text(json.dumps({'version': version, 'changelog': notes}) + '\n')
    (ROOT / 'release-notes.md').write_text(notes)
    paths = sorted(directory.iterdir())
    sums = '\n'.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in paths)
    (directory / 'checksums.sha256').write_text(sums + '\n')
    repository = os.environ['GITHUB_REPOSITORY']
    release = api(f'repos/{repository}/releases/tags/{tag}')
    if release and not release['draft']:
        raise RuntimeError('Refusing to modify an already published release')
    if not release:
        run('gh', 'release', 'create', tag, '--draft', '--verify-tag', '--title',
            f'{info["app_tag"]} + AnyTLS REALITY {info["core_tag"]}', '--notes-file', 'release-notes.md')
    run('gh', 'release', 'upload', tag, *map(str, sorted(directory.iterdir())), '--clobber')
    run('gh', 'release', 'edit', tag, '--draft=false', '--latest', '--notes-file', 'release-notes.md')


def selftest():
    assert stable_tag({'tag_name': 'v2.0.3', 'draft': False, 'prerelease': False}) == 'v2.0.3'
    for bad in ('alpha', 'v2.0.3-beta', 'v2.0.3/../../x'):
        try:
            stable_tag({'tag_name': bad, 'draft': False, 'prerelease': False})
        except ValueError:
            pass
        else:
            raise AssertionError(bad)
    assert len(installers('2.0.3')) == 6
    print('Release input and artifact checks passed')


if __name__ == '__main__':
    {'prepare': prepare, 'publish': publish, 'selftest': selftest}[sys.argv[1]]()
