"""Fail closed if an upstream change reintroduces official core/update downloads."""
from pathlib import Path
import subprocess

from overlay import verify_download_sources

root = Path(__file__).resolve().parents[1]
verify_download_sources(root)
prepare = (root / 'scripts/prepare.mjs').read_text(encoding='utf-8')
assert 'sha256sum.txt' in prepare and 'Core checksum mismatch' in prepare
assert 'mihomo-alpha' not in prepare and 'mihomo-smart' not in prepare
assert "'-go120'" in prepare
assert 'mihomo-anytls-specific' in (root / 'src/main/utils/dirs.ts').read_text(encoding='utf-8')
assert 'Core checksum mismatch' in (root / 'src/main/utils/github.ts').read_text(encoding='utf-8')
assert 'Promise.withResolvers' not in (root / 'src/main/window.ts').read_text(encoding='utf-8')
subprocess.run(['node', '--check', 'scripts/prepare.mjs'], cwd=root, check=True)
subprocess.run(['python', str(root / '.anytls/release.py'), 'selftest'], check=True)
print('Fork source guards passed')
