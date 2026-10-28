from pathlib import Path
import json,sys
p=Path(__file__).resolve().parent
paths=list((p/'timings').glob('*.log'))+list((p/'logs').glob('capture-*.log'))
for f in paths:
 s=f.read_text()
 if '### Result\n' not in s:
  print(f.name, 'INCOMPLETE OR ERROR',s[-500:]);continue
 payload=s.split('### Result\n',1)[1].split('\n### ',1)[0].strip()
 try:d=json.loads(payload)
 except json.JSONDecodeError as e: print(f.name,e);continue
 f.with_suffix('.json').write_text(json.dumps(d,indent=2)+'\n')
 print(f.name, d.get('metrics', {'views':len(d.get('views',[]))}), d.get('error'), d.get('errors',[]))
