"""Durable, locally stored incident evidence bundles."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path


def save_incident(envelope, context, incident):
    identity = envelope['id']
    if not re.fullmatch(r'[a-f0-9]{64}', identity):
        raise ValueError('Invalid artifact identity')
    root = Path(os.getenv('INCIDENT_ARTIFACT_ROOT', '.local-data/incidents')).resolve()
    folder = root / identity
    folder.mkdir(parents=True, exist_ok=True)
    shots = folder / 'snapshots'
    shots.mkdir(exist_ok=True)
    files, seen = [], {}
    report = incident['report']
    evidence = []
    for item in incident['evidence']:
        saved = {**item, 'screenshots': []}
        for shot in item.get('screenshots', []):
            data_url = shot.get('dataUrl', '')
            match = re.fullmatch(r'data:image/(jpeg|png);base64,([A-Za-z0-9+/=\r\n]+)', data_url)
            if not match:
                continue
            data = base64.b64decode(match[2], validate=True)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError('Screenshot exceeds storage limit')
            digest = hashlib.sha256(data).hexdigest()
            name = seen.get(digest)
            if name is None:
                name = f'snapshots/{len(seen)+1:03d}.{ "jpg" if match[1] == "jpeg" else "png" }'
                (folder / name).write_bytes(data)
                seen[digest] = name
                files.append({'path': name, 'sha256': digest, 'bytes': len(data)})
            report = report.replace(data_url, name)
            saved['screenshots'].append({'label': shot.get('label'), 'path': name})
        evidence.append(saved)
    (folder / 'report.md').write_text(report, encoding='utf-8')
    (folder / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    (folder / 'handoff.json').write_text(json.dumps(envelope, indent=2), encoding='utf-8')
    (folder / 'source-snapshot.json').write_text(json.dumps(context.evidence['context'], indent=2), encoding='utf-8')
    manifest = {'schemaVersion': 1, 'incidentId': incident['id'], 'handoffId': identity,
        'source': envelope.get('source'), 'capture': incident['screenshots'], 'snapshots': files,
        'files': ['report.md', 'evidence.json', 'handoff.json', 'source-snapshot.json']}
    temporary = folder / 'manifest.tmp'
    temporary.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    temporary.replace(folder / 'manifest.json')
    incident['report'] = report
    incident['evidence'] = evidence
    return {'folder': f'incidents/{identity}', 'snapshotCount': len(files),
            'files': [*manifest['files'], 'manifest.json', *[file['path'] for file in files]]}
