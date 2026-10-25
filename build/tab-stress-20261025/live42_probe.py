import datetime as dt
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

root = Path(__file__).parent / 'live42'
root.mkdir(exist_ok=True)
cfg = json.loads((Path(os.environ['APPDATA']) / 'SAMBA Browser/config.json').read_text(encoding='utf-8'))
base = f"http://127.0.0.1:{cfg['bridgePort']}"
headers = {'X-Samba-Token': cfg['bridgeToken'], 'X-Samba-Lane': 'cc-rendering-final-load', 'Content-Type': 'application/json'}
opened, rows = [], []

def call(name, args, global_list=False):
    started = time.perf_counter()
    request_headers = dict(headers)
    if global_list:
        request_headers.pop('X-Samba-Lane')
    req = urllib.request.Request(base + '/tool/' + name, data=json.dumps({'args': args}).encode(), headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=100) as response:
            value = json.load(response)
        status = 200
    except urllib.error.HTTPError as error:
        status, value = error.code, {}
    except Exception as error:
        status, value = 0, {'error': type(error).__name__}
    row = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'tool': name, 'http': status, 'ms': round((time.perf_counter()-started)*1000,1)}
    text = value.get('result', '')
    text = text if isinstance(text,str) else json.dumps(text)
    row['tool_error'] = text.startswith(('error:', 'no visible page')) or status != 200
    if name == 'screenshot':
        match = re.search(r'\((\d+)x(\d+)\)',text)
        row['size'] = [int(match[1]),int(match[2])] if match else None
        row['valid'] = bool(match and int(match[1])>0 and int(match[2])>0 and not row['tool_error'])
        if not row['valid']:
            row['message'] = text[:180]
    if name == 'list_tabs' and global_list:
        try:
            tabs = json.loads(text)
            row['tabs'] = len(tabs)
            row['lanes'] = len({t.get('lane') for t in tabs if t.get('lane')})
        except (ValueError,TypeError):
            pass
    rows.append(row)
    with (root/'requests.jsonl').open('a',encoding='utf-8') as f:
        f.write(json.dumps(row,ensure_ascii=False)+'\n')
    return text

try:
    call('list_tabs',{},True)
    sites = ['https://www.ssg.com/','https://www.lemouton.co.kr/','https://www.lotteon.com/p/display/main/lotteon']*3 + ['https://example.com/']*15
    for url in sites:
        result = call('new_tab',{'url':url})
        match = re.search(r'\btab ([0-9a-f-]{36})',result)
        if match:
            opened.append(match[1])
        time.sleep(.2)
    (root/'owned-tabs.json').write_text(json.dumps(opened),encoding='utf-8')
    call('list_tabs',{},True)
    deadline = time.monotonic()+180
    n = 0
    while opened and time.monotonic()<deadline and not (root/'stop.flag').exists():
        call('switch_tab',{'id':opened[n%len(opened)]})
        if n%8 == 0:
            call('get_page',{})
        call('screenshot',{})
        if n%8 == 0:
            call('list_tabs',{},True)
        n += 1
        time.sleep(.3)
finally:
    for tab in opened:
        call('close_tab',{'id':tab})
    captures = [r for r in rows if r['tool']=='screenshot']
    values = sorted(r['ms'] for r in captures)
    summary = {'opened':len(opened),'operations':len(rows),'captures':len(captures),'capture_errors':sum(not r['valid'] for r in captures),'http_errors':sum(r['http']!=200 for r in rows),'max_tabs':max((r.get('tabs',0) for r in rows),default=0),'max_lanes':max((r.get('lanes',0) for r in rows),default=0),'capture_median_ms':values[len(values)//2] if values else None,'capture_p95_ms':values[int((len(values)-1)*.95)] if values else None,'capture_max_ms':max(values,default=None),'cleanup_completed':True}
    (root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False))
