"""Replay the real overlay against a pinned upstream tree without starting the app."""
import io
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

from overlay import apply, LITERALS

ROOT = Path(__file__).resolve().parents[1]


def replay(ref):
    patch = (ROOT / '.anytls/client.patch').read_text(encoding='utf-8')
    required = set(re.findall(r'^\+\+\+ b/(.+)$', patch, re.MULTILINE))
    required.update(name for name, *_ in LITERALS)
    tracked = set(subprocess.check_output([
        'git', 'ls-tree', '-r', '--name-only', ref
    ], cwd=ROOT).decode('utf-8').splitlines())
    archive = subprocess.check_output([
        'git', 'archive', '--format=zip', ref, '--', *sorted(required & tracked)
    ], cwd=ROOT)
    temporary_root = (ROOT.parents[1] / 'temp').resolve()
    if not temporary_root.is_relative_to(ROOT.parents[1].resolve()):
        raise ValueError('Replay directory must remain inside Client')
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='party-overlay-replay-', dir=temporary_root) as directory:
        source = Path(directory).resolve()
        if not source.is_relative_to(temporary_root):
            raise ValueError('Unexpected replay directory')
        with zipfile.ZipFile(io.BytesIO(archive)) as files:
            files.extractall(source)
        subprocess.run(['git', 'init', '--quiet', str(source)], check=True)
        subprocess.run(['git', '-c', 'core.autocrlf=false', 'add', '.'], cwd=source,
                       capture_output=True, check=True)
        apply(source)
        print(f'{ref}: strict source overlay replay passed')


if __name__ == '__main__':
    replay(sys.argv[1])
