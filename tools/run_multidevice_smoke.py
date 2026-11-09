"""Three disposable native Zotero clients; loopback WebDAV fixture; no user credentials."""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import argparse, base64, hashlib, json, os, subprocess, sys, threading, time, uuid
parser=argparse.ArgumentParser();parser.add_argument('--zotero',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];run=root/'.work'/('multidevice-native-'+uuid.uuid4().hex[:8]);run.mkdir(parents=True)
state={'records':{},'roles':set(),'notes':{},'grants':[],'peakRunning':0};mutex=threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def answer(self,status,value=None,etag=None):
        body=json.dumps(value).encode() if value is not None else b'';self.send_response(status)
        self.send_header('Content-Length',str(len(body)));self.send_header('Content-Type','application/json')
        if etag:self.send_header('ETag',etag)
        self.end_headers()
        if body:self.wfile.write(body)
    def do_GET(self):
        with mutex:
            if self.path.startswith('/fixture/barrier'):return self.answer(200,{'ready':len(state['roles'])==3})
            if self.path=='/fixture/notes':return self.answer(200,state['notes'])
            r=state['records'].get(self.path)
            return self.answer(200,r['data'],r['etag']) if r else self.answer(404)
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        with mutex:
            if self.path.startswith('/fixture/barrier/'):state['roles'].add(self.path.rsplit('/',1)[1])
            elif self.path.startswith('/fixture/notes/'):state['notes'][self.path.rsplit('/',1)[1]]=data
            else:return self.answer(404)
            return self.answer(200,{'ok':True})
    def do_MKCOL(self):return self.answer(201) if self.path=='/claims/' else self.answer(404)
    def do_PUT(self):
        expected='Basic '+base64.b64encode(b'synthetic:synthetic-only-password').decode()
        if self.headers.get('Authorization')!=expected:return self.answer(401)
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')));data=json.loads(raw)
        with mutex:
            old=state['records'].get(self.path);create=self.headers.get('If-None-Match')=='*';match=self.headers.get('If-Match')
            if create and old or match and (not old or old['etag']!=match):return self.answer(412)
            if not create and not match:return self.answer(428)
            etag='"'+hashlib.sha256(raw).hexdigest()+'"';state['records'][self.path]={'data':data,'etag':etag}
            if '/probe-' not in self.path:
                if data.get('state')=='running' and (not old or old['data'].get('token')!=data.get('token')):state['grants'].append({'task':data['task'],'owner':data['owner'],'token':data['token']})
                active=sum(x['data'].get('state')=='running' for k,x in state['records'].items() if '/probe-' not in k);state['peakRunning']=max(state['peakRunning'],active)
            return self.answer(204 if old else 201,etag=etag)
    def do_DELETE(self):
        with mutex:
            if not self.path.startswith('/claims/probe-'):return self.answer(403)
            old=state['records'].get(self.path)
            if not old:return self.answer(404)
            if self.headers.get('If-Match')!=old['etag']:return self.answer(412)
            del state['records'][self.path];return self.answer(204)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)
prepare=root/'project/tests/prepare_smoke.py';original_args=sys.argv[:];profiles=[];processes=[]
try:
    for role in range(3):
        profile=run/('device-'+str(role));profiles.append(profile)
        code=prepare.read_text(encoding='utf-8').replace('.work/multidevice-profile',profile.relative_to(root).as_posix())
        sys.argv=[str(prepare),'--multidevice'];exec(compile(code,str(prepare),'exec'),{'__file__':str(prepare),'__name__':'__main__'})
        (profile/'coordination-fixture.json').write_text(json.dumps({'url':url,'role':role}),encoding='utf-8')
    env=dict(os.environ,MOZ_HEADLESS='1',MOZ_NO_REMOTE='1')
    for profile in profiles:
        processes.append(subprocess.Popen([args.zotero,'-no-remote','-new-instance','-profile',str(profile),'-datadir',str(profile/'data'),'-headless','-purgecaches'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)))
    print('RUN_DIRECTORY='+str(run),flush=True);deadline=time.monotonic()+150
    while time.monotonic()<deadline:
        if all((p/'multidevice-fatal.json').exists() or ((p/'multidevice-result.json').exists() and json.loads((p/'multidevice-result.json').read_text(encoding='utf-8')).get('completed')) for p in profiles):break
        time.sleep(.3)
    reports=[]
    for p in profiles:
        fatal=p/'multidevice-fatal.json';result=p/'multidevice-result.json'
        reports.append(json.loads((fatal if fatal.exists() else result).read_text(encoding='utf-8')) if fatal.exists() or result.exists() else {'error':'Native fixture timed out','profile':str(p)})
    with mutex:
        shared={'grants':state['grants'],'peakRunning':state['peakRunning'],'completedTasks':sum(x['data']['state']=='done' for k,x in state['records'].items() if '/probe-' not in k),'savedSyntheticNotes':len(state['notes'])}
    good=all(r.get('completed') and all(t['ok'] for t in r['tests']) for r in reports)
    good=good and len(shared['grants'])==3 and len({x['task'] for x in shared['grants']})==3 and len({x['owner'] for x in shared['grants']})==3 and shared['peakRunning']==3 and shared['completedTasks']==3
    result={'passed':good,'clients':reports,'shared':shared,'realCloudRequests':0,'realModelRequests':0,'personalLibraryTouched':False,'simulatedZoteroSync':True}
    (run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=True),flush=True)
    if not good:raise SystemExit(1)
finally:
    sys.argv=original_args;server.shutdown();server.server_close()
