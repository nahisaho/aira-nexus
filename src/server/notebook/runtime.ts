import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { NotebookDriver, NotebookInput } from './service.js';
import type { NotebookKernel } from './repository.js';
import { notebookUnavailable } from './repository.js';
import { NotebookKubernetes } from './kubernetes.js';
import { MAX_FILE_BYTES } from '../../shared/files.js';
import { NOTEBOOK_OUTPUT_BYTES } from '../../shared/notebook.js';

const supervisor = String.raw`
import os,ctypes,threading,hmac
from http.server import BaseHTTPRequestHandler,HTTPServer
from jupyter_server.serverapp import ServerApp
token=os.environ.pop("NOTEBOOK_TOKEN")
if ctypes.CDLL(None).prctl(4,0,0,0,0)!=0: raise RuntimeError("Parent protection unavailable")
timer=None
lock=threading.Lock()
class Control(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  global timer
  if not hmac.compare_digest(self.headers.get("Authorization",""),"Bearer "+token):
   self.send_error(403);return
  if self.path not in ("/arm","/cancel"): self.send_error(404);return
  with lock:
   if timer is not None: timer.cancel();timer=None
   if self.path=="/arm":
    timer=threading.Timer(120,lambda:os._exit(124));timer.daemon=True;timer.start()
  self.send_response(204);self.end_headers()
threading.Thread(target=HTTPServer(("0.0.0.0",8889),Control).serve_forever,daemon=True).start()
app=ServerApp.instance()
app.initialize([])
app.ip="0.0.0.0";app.port=8888;app.port_retries=0;app.open_browser=False
app.allow_remote_access=True;app.terminals_enabled=False
app.identity_provider.token=token
app.contents_manager_class="jupyter_server.services.contents.manager.ContentsManager"
app.root_dir="/outputs";app.log_level=50
app.start()
`;
const staging = String.raw`
import os,json,hmac,hashlib
from http.server import BaseHTTPRequestHandler,HTTPServer
plan=json.loads(os.environ["NOTEBOOK_INPUTS"])
token=os.environ.pop("NOTEBOOK_TOKEN");done=set()
class H(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_PUT(self):
  if not hmac.compare_digest(self.headers.get("Authorization",""),"Bearer "+token):
   self.send_error(403);return
  item=next((x for x in plan if "/"+x["id"]==self.path),None)
  if item is None or item["id"] in done or self.headers.get("Content-Length")!=str(item["size"]):
   self.send_error(400);return
  directory="/inputs/"+item["id"];os.mkdir(directory)
  path=directory+"/"+item["name"];digest=hashlib.sha256();left=item["size"]
  with open(path,"xb") as output:
   while left:
    chunk=self.rfile.read(min(left,65536))
    if not chunk: self.send_error(400);return
    left-=len(chunk);digest.update(chunk);output.write(chunk)
  if digest.hexdigest()!=item["sha256"]: self.send_error(400);return
  os.chmod(path,0o444);os.chmod(directory,0o555);done.add(item["id"])
  self.send_response(204);self.end_headers()
 def do_POST(self):
  if not hmac.compare_digest(self.headers.get("Authorization",""),"Bearer "+token) or self.path!="/commit" or len(done)!=len(plan):
   self.send_error(400);return
  self.send_response(204);self.end_headers();self.wfile.flush();os._exit(0)
HTTPServer(("0.0.0.0",8888),H).serve_forever()
`;
const guardPython = 'import ctypes\n_nb_guard = ctypes.CDLL("/opt/notebook/guard.so")\nassert _nb_guard.notebook_guard() == 0, "Notebook syscall isolation unavailable"\ndel _nb_guard';
const guardR = 'dyn.load("/opt/notebook/guard.so"); stopifnot(.C("notebook_guard_R", status=as.integer(-1))$status == 0L)';

/** @id CODE-NB-010 @implements REQ-NB-001 REQ-NB-002 REQ-NB-003 REQ-NB-004 REQ-NB-005 */
export class NotebookRuntime implements NotebookDriver {
  readonly kube: NotebookKubernetes;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const gateway=env.NOTEBOOK_GATEWAY_NAMESPACE,pod=env.HOSTNAME,deployment=env.NOTEBOOK_DEPLOYMENT_ID;
    const prefix=env.NOTEBOOK_NAMESPACE_PREFIX ?? 'aira-nb-';
    const image=env.NOTEBOOK_KERNEL_IMAGE;
    if (!env.KUBERNETES_SERVICE_HOST || !gateway || !/^[a-z0-9-]{1,63}$/.test(gateway) ||
      !pod || !/^[a-z0-9-]{1,63}$/.test(pod) || !deployment || !/^[a-f0-9-]{36}$/.test(deployment) ||
      !/^[a-z][a-z0-9-]{0,20}-$/.test(prefix) || !image || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw notebookUnavailable();
    this.kube=new NotebookKubernetes(gateway,pod,deployment,prefix,image);
  }
  async ready() {
    const runtime=await this.kube.json(['get','runtimeclass','kata']);
    if (runtime.handler!=='kata') throw notebookUnavailable();
    const namespace=await this.kube.json(['get','namespace',this.kube.gateway]);
    const pod=await this.kube.json(['-n',this.kube.gateway,'get','pod',this.kube.pod]);
    if (namespace.metadata?.labels?.['aira.nexus/role']!=='notebook-gateway' ||
      pod.metadata?.labels?.['aira.nexus/component']!=='notebook-gateway') throw notebookUnavailable();
  }
  private name(kernel: NotebookKernel) { return `${kernel.language}-${kernel.generation}`; }
  private async ip(kernel: NotebookKernel) {
    const pod=await this.kube.json(['-n',this.kube.namespace(kernel.project),'get','pod',this.name(kernel)]);
    if (pod.metadata?.labels?.['aira.nexus/generation']!==kernel.generation) throw notebookUnavailable();
    const status=pod.status as {podIP?:string};
    if (!status.podIP || !/^[0-9.]+$/.test(status.podIP)) throw notebookUnavailable();
    return status.podIP;
  }
  private async http(kernel: NotebookKernel, path: string, method='GET', value?: unknown) {
    const ip=await this.ip(kernel);
    const response=await fetch(`http://${ip}:8888${path}`,{
      method,headers:{Authorization:`token ${kernel.token}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(10000),...(value===undefined?{}:{body:JSON.stringify(value)}),
    });
    if (!response.ok) throw notebookUnavailable();
    return response;
  }
  async start(kernel: NotebookKernel, inputs: NotebookInput[]) {
    await this.ready();
    const namespace=await this.kube.prepare(kernel.project);
    await this.kube.verify(namespace);
    const pod=this.kube.podObject(namespace,this.name(kernel),['python3','-u','-c',supervisor],'notebook-kernel');
    pod.metadata.labels['aira.nexus/generation']=kernel.generation;
    const container={...pod.spec.containers[0]!,
      env:[{name:'NOTEBOOK_TOKEN',value:kernel.token},{name:'HOME',value:'/tmp'},{name:'JUPYTER_RUNTIME_DIR',value:'/tmp/jupyter'},{name:'IPYTHONDIR',value:'/tmp/ipython'}],
      workingDir:'/outputs',
      volumeMounts:[...pod.spec.containers[0]!.volumeMounts,{name:'inputs',mountPath:'/data',readOnly:true},{name:'outputs',mountPath:'/outputs'}],
      readinessProbe:{httpGet:{path:'/api',port:8888,httpHeaders:[{name:'Authorization',value:`token ${kernel.token}`}]},periodSeconds:1,failureThreshold:120},
    };
    const plan=inputs.map(file=>({id:file.id,name:file.name,size:file.bytes.length,sha256:createDigest(file.bytes)}));
    const complete={...pod,spec:{...pod.spec,containers:[container],
      ...(inputs.length?{initContainers:[{...container,name:'stage',command:['python3','-u','-c',staging],workingDir:'/tmp',readinessProbe:undefined,
        env:[{name:'NOTEBOOK_TOKEN',value:kernel.token},{name:'NOTEBOOK_INPUTS',value:JSON.stringify(plan)}],
        volumeMounts:[{name:'inputs',mountPath:'/inputs'},{name:'tmp',mountPath:'/tmp'}],
      }]}:{}),
      volumes:[...pod.spec.volumes,{name:'inputs',emptyDir:{sizeLimit:'256Mi'}},{name:'outputs',emptyDir:{sizeLimit:'512Mi'}}],
    }};
    await this.kube.create(complete);
    if (inputs.length) {
      await this.kube.command(['-n',namespace,'wait',`pod/${this.name(kernel)}`,'--for=jsonpath={.status.podIP}','--timeout=120s']);
      const ip=await this.ip(kernel);
      const deadline=Date.now()+120000;
      while(true) {
        try { const r=await fetch(`http://${ip}:8888/no-such-file`,{method:'PUT',headers:{Authorization:`Bearer ${kernel.token}`,'Content-Length':'0'},signal:AbortSignal.timeout(1000)});if(r.status===400)break; }
        catch { /* Wait for the init container listener, not a fixed startup delay. */ }
        if(Date.now()>deadline)throw notebookUnavailable();
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      for (const file of inputs) {
        const response=await fetch(`http://${ip}:8888/${file.id}`,{method:'PUT',headers:{Authorization:`Bearer ${kernel.token}`,'Content-Length':String(file.bytes.length)},body:Buffer.from(file.bytes),signal:AbortSignal.timeout(120000)});
        if(response.status!==204)throw notebookUnavailable();
      }
      const commit=await fetch(`http://${ip}:8888/commit`,{method:'POST',headers:{Authorization:`Bearer ${kernel.token}`},signal:AbortSignal.timeout(10000)});
      if(commit.status!==204)throw notebookUnavailable();
    }
    await this.kube.command(['-n',namespace,'wait',`pod/${this.name(kernel)}`,'--for=condition=Ready','--timeout=120s']);
    await this.http(kernel,'/api/kernels','POST',{name:kernel.language==='python'?'python3':'ir'});
    await this.executeRequest(kernel,kernel.language==='python'?guardPython:guardR,AbortSignal.timeout(30000),true);
  }
  async exists(kernel: NotebookKernel) {
    const bytes=await this.kube.command(['-n',this.kube.namespace(kernel.project),'get','pod',this.name(kernel),'--ignore-not-found','-o','json']);
    if (!bytes.length) return false;
    const pod=JSON.parse(bytes.toString());
    if(pod.metadata.labels['aira.nexus/generation']!==kernel.generation)throw notebookUnavailable();
    return pod.status.phase==='Running' && !pod.metadata.deletionTimestamp;
  }
  async stop(kernel: NotebookKernel) {
    const namespace=this.kube.namespace(kernel.project);
    await this.kube.remove(namespace,'pod',this.name(kernel));
    const pods=await this.kube.json(['-n',namespace,'get','pods']);
    if (!(pods.items as unknown[]).length) await this.kube.remove(namespace,'namespace',namespace);
  }
  private async control(kernel: NotebookKernel, action: 'arm' | 'cancel') {
    const ip=await this.ip(kernel);
    const response=await fetch(`http://${ip}:8889/${action}`,{method:'POST',headers:{Authorization:`Bearer ${kernel.token}`},signal:AbortSignal.timeout(5000)});
    if(response.status!==204)throw notebookUnavailable();
  }
  async execute(kernel: NotebookKernel, code: string, signal: AbortSignal) {
    await this.kube.prepare(kernel.project);
    await this.control(kernel,'arm');
    try {return await this.executeRequest(kernel,code,signal,false);}
    finally {await this.control(kernel,'cancel').catch(()=>{});}
  }
  private async executeRequest(kernel: NotebookKernel, code: string, signal: AbortSignal, bootstrap: boolean): Promise<string> {
    const response=await this.http(kernel,'/api/kernels');
    const inventory=await response.json() as {id:string}[];
    if(inventory.length!==1 || !/^[a-f0-9-]{36}$/.test(inventory[0]!.id))throw notebookUnavailable();
    const ip=await this.ip(kernel),id=randomUUID(),session=randomUUID();
    return new Promise((resolve,reject)=>{
      const socket=new WebSocket(`ws://${ip}:8888/api/kernels/${inventory[0]!.id}/channels?session_id=${session}`,{
        headers:{Authorization:`token ${kernel.token}`},maxPayload:NOTEBOOK_OUTPUT_BYTES+65536,handshakeTimeout:10000,
      });
      let output='',bytes=0,settled=false,error=false;
      const finish=(failure?:unknown)=>{
        if(settled)return;settled=true;signal.removeEventListener('abort',abort);socket.terminate();
        if(failure || (bootstrap && error))reject(notebookUnavailable());else resolve(output);
      };
      const abort=()=>finish(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      socket.on('error',finish);
      socket.on('close',()=>finish(new Error('Kernel channel closed.')));
      socket.on('open',()=>socket.send(JSON.stringify({
        header:{msg_id:id,username:'notebook',session,msg_type:'execute_request',version:'5.3'},
        parent_header:{},metadata:{},channel:'shell',
        content:{code,silent:false,store_history:!bootstrap,user_expressions:{},allow_stdin:false,stop_on_error:true},
      })));
      const append=(text:string)=>{
        const buffer=Buffer.from(text),remaining=NOTEBOOK_OUTPUT_BYTES-bytes;
        if(remaining>0){const next=buffer.subarray(0,Math.max(0,remaining-3));output+=new TextDecoder().decode(next);bytes+=Buffer.byteLength(output)-bytes;}
      };
      socket.on('message',data=>{
        try {
          const message=JSON.parse(data.toString());
          if(message.parent_header?.msg_id!==id)return;
          const content=message.content;
          switch(message.header?.msg_type) {
            case 'stream': if(typeof content?.text==='string')append(content.text);break;
            case 'execute_result': case 'display_data':
              if(typeof content?.data?.['text/plain']==='string')append(content.data['text/plain']);break;
            case 'error':error=true;append(`[${String(content?.ename).slice(0,128)}] ${String(content?.evalue).slice(0,4096)}\n`);break;
            case 'status':if(content?.execution_state==='idle')finish();break;
          }
        } catch {finish(notebookUnavailable());}
      });
    });
  }
  async artifact(kernel: NotebookKernel, name: string) {
    const code=String.raw`import os,sys,stat
name=sys.argv[1]
fd=os.open("/outputs/"+name,os.O_RDONLY|os.O_NOFOLLOW)
meta=os.fstat(fd)
if not stat.S_ISREG(meta.st_mode) or meta.st_size>100000000: raise RuntimeError("Invalid artifact")
with os.fdopen(fd,"rb") as source:
 while True:
  block=source.read(65536)
  if not block: break
  sys.stdout.buffer.write(block)
`;
    return this.kube.command(['-n',this.kube.namespace(kernel.project),'exec',this.name(kernel),'--','python3','-c',code,name],undefined,MAX_FILE_BYTES);
  }
}
import { createHash } from 'node:crypto';
function createDigest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
