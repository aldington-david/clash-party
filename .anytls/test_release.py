"""Offline checks for overlay drift and publication boundaries; no app or network access."""
import copy
import json
from pathlib import Path
from subprocess import CompletedProcess
import unittest
from unittest.mock import patch

import overlay
import release


class ReleaseTests(unittest.TestCase):
    def test_release_lookup_reads_drafts_and_public_releases_by_id(self):
        lookup = CompletedProcess([], 0, json.dumps({
            'apiUrl': 'https://api.github.com/repos/owner/repo/releases/123'
        }), '')
        for draft in (True, False):
            expected = {'id': 123, 'draft': draft}
            with patch('release.subprocess.run', return_value=lookup), patch('release.api', return_value=expected) as api:
                self.assertEqual(release.release_for_tag('owner/repo', 'v1.0.0'), expected)
                api.assert_called_once_with('repos/owner/repo/releases/123')

    def test_only_a_missing_tag_is_treated_as_no_release(self):
        with patch('release.subprocess.run', return_value=CompletedProcess([], 1, '', 'release not found\n')), patch('release.api') as api:
            self.assertIsNone(release.release_for_tag('owner/repo', 'missing'))
            api.assert_not_called()
        with patch('release.subprocess.run', return_value=CompletedProcess([], 1, '', 'HTTP 502: Bad Gateway')):
            with self.assertRaises(RuntimeError):
                release.release_for_tag('owner/repo', 'v1.0.0')
        lookup = CompletedProcess([], 0, json.dumps({
            'apiUrl': 'https://api.github.com/repos/owner/repo/releases/123'
        }), '')
        with patch('release.subprocess.run', return_value=lookup), patch('release.api', return_value=None):
            with self.assertRaises(RuntimeError):
                release.release_for_tag('owner/repo', 'v1.0.0')
        with patch('release.subprocess.run', return_value=lookup), patch('release.api', side_effect=RuntimeError('network failure')):
            with self.assertRaisesRegex(RuntimeError, 'network failure'):
                release.release_for_tag('owner/repo', 'v1.0.0')

    def verify_sources(self, extra):
        files = {name: new for name, _, new, _ in overlay.LITERALS}
        files.update(extra)
        tracked = '\0'.join(files).encode()
        with patch('overlay.subprocess.check_output', return_value=tracked), patch.object(
            Path, 'read_text', lambda path, **_: files[path.as_posix().removeprefix('source/')]
        ):
            overlay.verify_download_sources('source')

    def test_literals_ignore_layout_but_require_the_exact_count(self):
        for text in ("open('old')", "Link(target: 'old')"):
            self.assertIn("'new'", overlay.replace_literal(text, "'old'", "'new'", 1))
        for text in ('missing', 'old old', 'old new'):
            with self.assertRaises(ValueError):
                overlay.replace_literal(text, 'old', 'new', 1)

    def test_new_source_file_cannot_restore_an_official_download(self):
        for url in ('https://github.com/MetaCubeX/mihomo/releases/latest/download/core.gz',
                    'https://api.github.com/repos/mihomo-party-org/clash-party/releases/latest',
                    "getTags('MetaCubeX', 'mihomo')"):
            with self.assertRaises(ValueError):
                self.verify_sources({'src/main/new-download.ts': url})

    def test_model_data_and_unused_release_note_helpers_are_narrow_exceptions(self):
        self.verify_sources({name: '\n'.join(repr(url) for url in urls)
                             for name, urls in overlay.ALLOWED_REFERENCES.items()})
        self.verify_sources({'scripts/new-data.mjs':
                             'https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat'})
        model = overlay.ALLOWED_REFERENCES['src/main/core/smartModel.ts'][0]
        for name, url in (('src/main/new-download.ts', model),
                          ('src/main/core/smartModel.ts', model + '-core')):
            with self.assertRaises(ValueError):
                self.verify_sources({name: repr(url)})

    def test_failed_tag_cannot_reuse_an_old_recipe(self):
        info = {'app_tag': 'v2.0.3', 'core_tag': 'v1.19.32', 'core_sha': 'core', 'recipe_sha256': 'current'}
        with patch('release.recipe_sha256', return_value='current'):
            release.verify_source_info(info, 'v2.0.3', 'v1.19.32', 'core')
            for key in ('app_tag', 'core_sha', 'recipe_sha256'):
                with self.assertRaises(ValueError):
                    release.verify_source_info(dict(info, **{key: 'old'}), 'v2.0.3', 'v1.19.32', 'core')

    def test_publication_requires_all_nine_uploaded_nonempty_assets(self):
        good = {'draft': True, 'prerelease': False, 'assets': [
            {'name': name, 'size': 1, 'state': 'uploaded'}
            for name in release.installers('2.0.3') | release.METADATA
        ]}
        release.verify_release_assets(good, '2.0.3', draft=True)
        mutations = ('missing', 'extra', 'empty', 'pending', 'published')
        for mutation in mutations:
            bad = copy.deepcopy(good)
            if mutation == 'missing':
                bad['assets'].pop()
            elif mutation == 'extra':
                bad['assets'].append({'name': 'portable.zip', 'size': 1, 'state': 'uploaded'})
            elif mutation == 'empty':
                bad['assets'][0]['size'] = 0
            elif mutation == 'pending':
                bad['assets'][0]['state'] = 'new'
            else:
                bad['draft'] = False
            with self.assertRaises(ValueError):
                release.verify_release_assets(bad, '2.0.3', draft=True)

    def test_each_build_must_bind_the_expected_core_and_source(self):
        info = {'core_tag': 'v1.19.32', 'source_commit': 'source'}
        builds = []
        for name, target in release.BUILD_CORES.items():
            extension = 'zip' if target.startswith('windows') else 'gz'
            builds.append({'build': name, 'asset': f'mihomo-{target}-v1.19.32.{extension}',
                           'repository': release.CORE, 'tag': 'v1.19.32', 'source_commit': 'source',
                           'sha256': 'a' * 64})
        assets = {build['asset']: 'sha256:' + build['sha256'] for build in builds}
        release.verify_builds(builds, info, assets)
        for key in ('build', 'asset', 'repository', 'tag', 'source_commit', 'sha256'):
            bad = copy.deepcopy(builds)
            bad[0][key] = 'wrong'
            with self.assertRaises(ValueError):
                release.verify_builds(bad, info, assets)


if __name__ == '__main__':
    unittest.main()
