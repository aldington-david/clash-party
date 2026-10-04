"""Keep repository literals independent of upstream UI layout; reject download-source drift."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LITERALS = (
    ('src/main/utils/ipc.ts', "'MetaCubeX', 'mihomo'", "'aldington-david', 'mihomo'", 3),
    ('src/main/utils/github.ts', 'https://github.com/MetaCubeX/mihomo/releases/download/',
     'https://github.com/aldington-david/mihomo/releases/download/', 1),
    ('src/main/resolve/autoUpdater.ts', 'mihomo-party-org/mihomo-party', 'aldington-david/clash-party', 3),
    ('src/renderer/src/components/updater/updater-modal.tsx',
     '`https://github.com/mihomo-party-org/mihomo-party/releases/tag/v${version}`',
     "'https://github.com/aldington-david/clash-party/releases/latest'", 1),
)

# These are model data or unused upstream release-note helpers, never packaged core downloads.
ALLOWED_REFERENCES = {
    'src/main/core/smartModel.ts': (
        'https://github.com/vernesong/mihomo/releases/download/LightGBM-Model',
    ),
    'scripts/version-utils.mjs': (
        'https://github.com/mihomo-party-org/clash-party/releases/download/dev',
        'https://github.com/mihomo-party-org/clash-party/releases/download/v${version}',
    ),
    'scripts/telegram.mjs': (
        'https://github.com/mihomo-party-org/clash-party/releases/tag/dev',
        'https://github.com/mihomo-party-org/clash-party/releases/tag/v${version}',
    ),
}
FORBIDDEN_SOURCE = re.compile(
    r'(?:MetaCubeX|vernesong)/mihomo/releases\b|'
    r'mihomo-party-org/(?:mihomo-party|clash-party)/releases\b|'
    r"['\"](?:MetaCubeX|vernesong)['\"]\s*,\s*['\"]mihomo['\"]",
    re.IGNORECASE,
)


def replace_literal(text, old, new, count):
    if text.count(old) != count or new in text:
        raise ValueError(f'Expected exactly {count} upstream occurrences of {old!r}')
    return text.replace(old, new)


def apply_literals(source):
    source = Path(source)
    for name, old, new, count in LITERALS:
        path = source / name
        path.write_text(replace_literal(path.read_text(encoding='utf-8'), old, new, count),
                        encoding='utf-8', newline='\n')


def verify_download_sources(source):
    source = Path(source)
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'src', 'scripts'], cwd=source)
    for name in filter(None, tracked.decode('utf-8').split('\0')):
        if Path(name).suffix not in ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'):
            continue
        if '.test.' in name or '.spec.' in name:
            continue
        text = (source / name).read_text(encoding='utf-8')
        for allowed in ALLOWED_REFERENCES.get(name, ()):
            text = re.sub(re.escape(allowed) + r"(?=['\"`])", '', text)
        match = FORBIDDEN_SOURCE.search(text)
        if match:
            raise ValueError(f'Official core/app release source remains in {name}: {match.group()}')
    for name, old, new, _ in LITERALS:
        text = (source / name).read_text(encoding='utf-8')
        if old in text or new not in text:
            raise ValueError(f'Fork repository literal missing from {name}')


def apply(source):
    source = Path(source)
    apply_literals(source)
    patch = str(ROOT / '.anytls/client.patch')
    subprocess.run(['git', 'apply', '--check', patch], cwd=source, check=True)
    subprocess.run(['git', 'apply', patch], cwd=source, check=True)
    verify_download_sources(source)
