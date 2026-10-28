import hashlib
import json
import pathlib
import struct
import subprocess
import zlib

root = pathlib.Path('/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028/worktree')
artifacts = root.parent / 'implementation'
before = json.loads((artifacts / 'baseline/screenshots.json').read_bytes())
after = json.loads((root / 'marketing/screenshots.json').read_bytes())
assert before.keys() == after.keys()
assert before['schemaVersion'] == after['schemaVersion']
assert before['releaseVersion'] == after['releaseVersion']
assert len(before['assets']) == len(after['assets'])
pngs = []
for original, optimized in zip(before['assets'], after['assets']):
    assert {k: v for k, v in original.items() if k != 'sha256'} == {k: v for k, v in optimized.items() if k != 'sha256'}
    content = (root / optimized['file']).read_bytes()
    assert hashlib.sha256(content).hexdigest() == optimized['sha256']
    offset = 8
    chunk_count = 0
    while offset < len(content):
        length = struct.unpack_from('>I', content, offset)[0]
        end = offset + 12 + length
        chunk = content[offset + 4:offset + 8 + length]
        expected_crc = struct.unpack_from('>I', content, offset + 8 + length)[0]
        assert zlib.crc32(chunk) == expected_crc
        offset = end
        chunk_count += 1
    assert offset == len(content)
    basename = pathlib.Path(optimized['file']).name
    original_rgba = (artifacts / 'raw' / (basename + '.baseline.rgba')).read_bytes()
    optimized_rgba = (artifacts / 'raw' / (basename + '.optimized.rgba')).read_bytes()
    assert original_rgba == optimized_rgba
    assert len(original_rgba) == optimized['width'] * optimized['height'] * 4
    pngs.append({'file': optimized['file'], 'allChunkCrcsValid': True, 'chunkCount': chunk_count, 'rgbaBytesIdentical': True, 'rgbaBytes': len(original_rgba)})
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
assert git('diff', '--cached', '--name-only') == ''
expected_files = sorted(['marketing/screenshots.json'] + [a['file'] for a in after['assets']])
assert sorted(git('diff', '--name-only').splitlines()) == expected_files
subprocess.run(['git', 'diff', '--check'], cwd=root, check=True)
report = {'changedFiles': expected_files, 'stagedFiles': [], 'manifestOnlySha256Changed': True, 'pngs': pngs}
(artifacts / 'final-source-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
