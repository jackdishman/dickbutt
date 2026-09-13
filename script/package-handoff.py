"""Create a source/evidence snapshot without credentials, generated binaries or dependencies."""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import re
import subprocess
import tempfile
import zipfile
import argparse

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--original', type=Path, default=root.parent.parent / 'dickbutt-main 2')
original = parser.parse_args().original.resolve()
if not original.is_dir():
    raise SystemExit('The supplied baseline is required to generate the change patch; set --original to its directory.')
destination = root / 'handoff'
destination.mkdir(exist_ok=True)
files = set()
for name in ['README.md', 'START-HERE.md', 'AERODROME-SETUP.md', 'AUDITOR-BRIEF.md', 'foundry.toml', 'package.json',
             'package-lock.json', 'calculate-rewards.js', '.gitignore']:
    if (root / name).is_file():
        files.add(Path(name))
for directory in ['src', 'test', 'calculator', 'keeper', 'operations', 'script', 'ui', 'docs', 'config']:
    for p in (root / directory).rglob('*'):
        if not p.is_file() or p.is_symlink():
            continue
        relative = p.relative_to(root)
        if any(part in {'node_modules', '.git', '.context', 'cache', 'out', '__pycache__'} for part in relative.parts):
            continue
        if p.name.startswith('.env') or '.local.' in p.name or '.partial' in p.name or p.suffix in {'.pyc', '.tmp'}:
            continue
        files.add(relative)
for name in ['base-inspection.json', 'clanker-source.json']:
    relative = Path('artifacts') / name
    if (root / relative).is_file():
        files.add(relative)

evidence = [
    'soak-heartbeat-20260913T1044Z.log', 'soak-1044-reconciliation.json',
    'soak-1044-swap-recovery.log', 'soak-1044-swap-recovery.json',
    'soak-1044-swap-verification.json', 'soak-1044-keeper-recheck.log',
    'soak-1044-monitor-recheck.json', 'soak-1044-reviewed-recovery.json',
    'soak-heartbeat-20260913T0827Z.log', 'soak-0827-reconciliation.json',
    'soak-0827-keyless-recheck.log', 'soak-0827-read-diagnostic.log',
    'soak-0827-archive-probe.json', 'soak-0827-archive-recheck.log',
    'soak-0827-archive-monitor.json', 'soak-0827-recovery.json',
    'alignment-npm.log', 'alignment-npm-expanded.log', 'alignment-npm-final.log',
    'alignment-forge.log', 'alignment-native-failure-trace.log',
    'alignment-native-corrected-runner.log', 'alignment-forge-expanded.log',
    'alignment-calculator-stress.json', 'alignment-rehearsal.log',
    'alignment-preflight-regression-before.log', 'alignment-preflight-regression-after.log',
    'alignment-mainnet-preflight.json', 'alignment-mainnet-preflight-final.json',
    'alignment-legacy-inspection.json', 'alignment-sepolia-tick.log',
    'npm-complete-handoff-approved.log', 'npm-complete-handoff.log',
    'npm-final-expanded.log', 'forge-final-capacity.log', 'extended-fuzz-invariants.log',
    'native-pipeline.log', 'native-aero-position.log', 'native-batch-expanded.log',
    'calculator-stress.json', 'npm-audit.json', 'payout-review-fixed.json',
    'rehearsal-rerun-3.log', 'fee-receipt-regression-before.log',
    'fee-receipt-regression-after.log', 'test-bot-gas-topups.json',
    'mainnet-preflight.json',
    'public-payout-verification.json', 'soak-first-tick.log',
    'running-results-snapshot.json', 'running-results-monitor.json',
    'npm-audit-before.json', 'npm-baseline.log',
    'pending-plan-regression-before.log', 'pending-plan-regression-after.log',
    'payout-review-reproduction.json', 'payout-review-reproduction.log', 'payout-review-fixed.log',
    'operational-regressions.log', 'local-verification.json', 'keeper-cli-repeat.json',
    'sepolia-deploy.log', 'sepolia-deploy-resume.log', 'sepolia-deploy-resume-2.log',
    'sepolia-deploy-resume-3.log', 'public-validation-resume-3.log',
    'second-cycle-recovery.log', 'soak-complete-report-tick.log',
]
for name in evidence:
    relative = Path('.context/test-results') / name
    if (root / relative).is_file():
        files.add(relative)
relative = Path('.context/soak-1044-swap-only.mjs')
if (root / relative).is_file():
    files.add(relative)
for name in ['validation.json', 'soak.json', 'propose-round.log',
             'payout-with-blocked-recipient.log', 'payout-retry.log', 'payout-idempotent-repeat.log']:
    relative = Path('.context/public-sepolia') / name
    if (root / relative).is_file():
        files.add(relative)
for p in (root / '.context/public-sepolia/journal').rglob('*.json'):
    if p.is_file():
        files.add(p.relative_to(root))
for p in (root / '.context/public-sepolia').glob('soak-*.log'):
    if p.is_file():
        files.add(p.relative_to(root))
for relative in [Path('.context/rehearsal-run-eM5J6m/report.json'),
                 Path('.context/rehearsal-run-eM5J6m/calculator-config.json')]:
    if (root / relative).is_file():
        files.add(relative)
for p in (root / '.context/rehearsal-run-eM5J6m/calculator/periods').glob('*.json'):
    files.add(p.relative_to(root))
for name in ['report.json', 'calculator-config.json']:
    relative = Path('.context/rehearsal-run-Rxoi5i') / name
    if (root / relative).is_file():
        files.add(relative)
for p in (root / '.context/rehearsal-run-Rxoi5i/calculator/periods').glob('*.json'):
    files.add(p.relative_to(root))

# Compare against the actual configured secrets without printing them or writing an intermediate file.
secrets = []
env_path = root.parent / '.env'
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        value = value.strip().strip('"\'')
        if re.search(r'PRIVATE_KEY|MNEMONIC', key) and len(value) > 16:
            secrets.append(value.encode())
            if value.startswith('0x'):
                secrets.append(value[2:].encode())

payload = {}
patch = []
for relative in sorted(files):
    data = (root / relative).read_bytes()
    if any(secret.lower() in data.lower() for secret in secrets):
        raise SystemExit(f'Package stopped: configured credential found in {relative}')
    payload[str(relative)] = data
    if relative.parts[0] == '.context':
        continue
    old = original / relative
    before = old.read_bytes() if old.is_file() else b''
    if before != data:
        try:
            changes = difflib.unified_diff(before.decode().splitlines(keepends=True),
                data.decode().splitlines(keepends=True),
                fromfile=f'a/{relative}' if old.is_file() else '/dev/null',
                tofile=f'b/{relative}')
            for line in changes:
                patch.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
        except UnicodeDecodeError:
            raise SystemExit(f'Cannot represent changed binary file in patch: {relative}')

metadata = {
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source': 'tested project', 'comparison': 'original project supplied by the owner',
    'note': 'Snapshot only. Consult current validation.json and soak.json for later public-test progress.',
    'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(payload.items())},
}
payload['SOURCE-MANIFEST.json'] = (json.dumps(metadata, indent=2) + '\n').encode()
payload['changes.patch'] = ''.join(patch).encode()
if any(secret.lower() in payload['changes.patch'].lower() for secret in secrets):
    raise SystemExit('Package stopped: a configured credential appears in an original file diff')
with tempfile.TemporaryDirectory(prefix='dickbutt-patch-check-') as temporary:
    tree = Path(temporary)
    for relative in files:
        if relative.parts[0] == '.context':
            continue
        old = original / relative
        if old.is_file():
            target = tree / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(old.read_bytes())
    check_patch = tree / 'verification.patch'
    check_patch.write_bytes(payload['changes.patch'])
    result = subprocess.run(['git', 'apply', '--check', str(check_patch)], cwd=tree, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit('Package stopped: patch does not apply cleanly: ' + result.stderr)
    applied = subprocess.run(['git', 'apply', str(check_patch)], cwd=tree, capture_output=True, text=True)
    if applied.returncode:
        raise SystemExit('Package stopped: patch application failed: ' + applied.stderr)
    for relative in files:
        if relative.parts[0] != '.context' and (tree / relative).read_bytes() != payload[str(relative)]:
            raise SystemExit(f'Package stopped: patched source mismatch: {relative}')
archive = destination / 'dickbutt-development-handoff.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in sorted(payload.items()):
        z.writestr(f'dickbutt-tested/{name}', data)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name, data in payload.items():
        assert z.read(f'dickbutt-tested/{name}') == data

# A complete credentials-free directory is also provided for users who want to zip it themselves.
folder = destination / 'dickbutt-tested'
if folder.exists():
    unexpected = [p for p in folder.rglob('*') if p.is_file() and str(p.relative_to(folder)) not in payload]
    if unexpected:
        raise SystemExit('Refusing to modify a package folder containing extra files; move it before regenerating.')
for name, data in payload.items():
    target = folder / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
(destination / 'changes.patch').write_bytes(payload['changes.patch'])
(destination / 'SOURCE-MANIFEST.json').write_bytes(payload['SOURCE-MANIFEST.json'])
print(json.dumps({'archive': str(archive), 'folder': str(folder), 'files': len(payload), 'bytes': archive.stat().st_size,
                  'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                  'configuredCredentialsIncluded': False, 'patchReproducesSource': True}, indent=2))
