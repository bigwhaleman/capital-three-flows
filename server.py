#!/usr/bin/env python3
"""Read-only static serving + fixed-source background refresh. Standard library only."""
import argparse,json,mimetypes,threading,time,os
from datetime import datetime,timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,unquote
from update_data import update,utcnow
ROOT=Path(__file__).resolve().parent;PUBLIC=ROOT/'public';STATE={'started_at':utcnow(),'refresh_interval_seconds':21600,'mode':'server'}
mimetypes.add_type('text/javascript','.mjs')
class Handler(SimpleHTTPRequestHandler):
 def list_directory(self,path):self.send_error(404);return None
 def end_headers(self):
  self.send_header('X-Content-Type-Options','nosniff')
  self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
  self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'")
  self.send_header('Cache-Control','no-cache')
  super().end_headers()
 def do_GET(self):
  path=unquote(urlsplit(self.path).path)
  if path=='/api/status':
   out={**STATE,'server_time':utcnow()};b=json.dumps(out).encode()
   self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  resolved=(PUBLIC/path.lstrip('/')).resolve()
  if not resolved.is_relative_to(PUBLIC.resolve()) or any(x.startswith('.') for x in Path(path).parts if x not in ['/', '.']): self.send_error(404);return
  super().do_GET()
def updater():
 while True:
  try:
   f=PUBLIC/'data'/'observations.json';old=json.loads(f.read_text()) if f.exists() else {}
   stamp=datetime.fromisoformat(old['generated_at']) if old.get('generated_at') else None
   age=(datetime.now(timezone.utc)-stamp).total_seconds() if stamp else 1e9
   if age>=STATE['refresh_interval_seconds']:
    STATE['updating']=True;data=update();STATE['last_completed_at']=data['generated_at']
    STATE['last_result']={k:v['status'] for k,v in data['sources'].items()}
   STATE['last_error']=None
  except Exception as e:STATE['last_error']=str(e)[:180]
  finally:STATE['updating']=False
  time.sleep(60)
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--port',type=int,default=int(os.getenv('PORT','3080')));ap.add_argument('--host',default='0.0.0.0');ap.add_argument('--no-update',action='store_true');args=ap.parse_args()
 if not args.no_update:threading.Thread(target=updater,daemon=True,name='fixed-source-updater').start()
 else:STATE['mode']='static-server';STATE['refresh_interval_seconds']=None
 print(f'Capital Flow Lab at http://{args.host}:{args.port}/',flush=True)
 ThreadingHTTPServer((args.host,args.port),partial(Handler,directory=str(PUBLIC))).serve_forever()
