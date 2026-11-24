import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { notebookUnavailable } from './repository.js';

type KubeObject = { metadata?: {name?:string;namespace?:string;labels?:Record<string,string>;uid?:string}; [key:string]:unknown };
/** @id CODE-NB-009 @implements REQ-NB-004 REQ-NB-005 */
export class NotebookKubernetes {
  constructor(public readonly gateway: string, public readonly pod: string, public readonly deployment: string, public readonly prefix: string, public readonly image: string) {}
  namespace(project: string) { return `${this.prefix}${project}`; }
  async command(args: string[], input?: string | Uint8Array, limit = 1048576): Promise<Buffer> {
    return new Promise((resolve,reject)=>{
      const child = spawn('kubectl',args,{stdio:['pipe','pipe','pipe'],env:{
        PATH:process.env.PATH,HOME:'/nonexistent',
        KUBERNETES_SERVICE_HOST:process.env.KUBERNETES_SERVICE_HOST,
        KUBERNETES_SERVICE_PORT:process.env.KUBERNETES_SERVICE_PORT,
      }});
      const chunks: Buffer[] = [];
      let size = 0, failed = false;
      const fail = () => {if (!failed) {failed=true;child.kill('SIGKILL');reject(notebookUnavailable());}};
      const timer = setTimeout(fail,150000);
      child.once('error',fail);
      child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>limit)fail();else chunks.push(data);});
      child.stderr.resume();
      child.stdin.on('error',fail);
      child.once('close',code=>{clearTimeout(timer);if(!failed){if(code===0)resolve(Buffer.concat(chunks));else reject(notebookUnavailable());}});
      child.stdin.end(input);
    });
  }
  async json(args: string[]) { return JSON.parse((await this.command([...args,'-o','json'])).toString()) as KubeObject; }
  async create(object: KubeObject) { return JSON.parse((await this.command(['create','-f','-','-o','json'],JSON.stringify(object))).toString()) as KubeObject; }
  async remove(namespace: string, kind: string, name: string) {
    const bytes = await this.command(['-n',namespace,'get',kind,name,'--ignore-not-found','-o','json']);
    if (!bytes.length) return;
    const object = JSON.parse(bytes.toString()) as KubeObject;
    if (!object.metadata) return;
    if (object.metadata.labels?.['aira.nexus/deployment'] !== this.deployment) throw notebookUnavailable();
    await this.command(['-n',namespace,'delete',kind,name,'--wait=true','--timeout=120s','--grace-period=0']);
  }
  labels(component: string): Record<string,string> { return {'aira.nexus/component':component,'aira.nexus/deployment':this.deployment}; }
  async prepare(project: string) {
    const namespace = this.namespace(project);
    const expected = {...this.labels('notebook-project'),'aira.nexus/project':project};
    const bytes = await this.command(['get','namespace',namespace,'--ignore-not-found','-o','json']);
    if (!bytes.length) await this.create({apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels:expected}});
    else {
      const object=JSON.parse(bytes.toString()) as KubeObject;
      if (Object.entries(expected).some(([key,value])=>object.metadata?.labels?.[key]!==value)) throw notebookUnavailable();
    }
    const policy = {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:{name:'notebook-isolation',namespace,labels:this.labels('notebook-policy')},
      spec:{podSelector:{},policyTypes:['Ingress','Egress'],egress:[],ingress:[{from:[{
        namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':this.gateway,'aira.nexus/role':'notebook-gateway'}},
        podSelector:{matchLabels:{'aira.nexus/component':'notebook-gateway'}},
      }],ports:[{protocol:'TCP',port:8888},{protocol:'TCP',port:8889}]}]}};
    const current=await this.command(['-n',namespace,'get','networkpolicy','notebook-isolation','--ignore-not-found','-o','json']);
    if (!current.length) await this.create(policy);
    else if (!isDeepStrictEqual(JSON.parse(current.toString()).spec,policy.spec)) throw notebookUnavailable();
    return namespace;
  }
  podObject(namespace: string, name: string, command: string[], component: string) {
    return {apiVersion:'v1',kind:'Pod',metadata:{namespace,name,labels:this.labels(component)},spec:{
      runtimeClassName:'kata',automountServiceAccountToken:false,restartPolicy:'Never',
      terminationGracePeriodSeconds:0,
      securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:100,fsGroup:100,seccompProfile:{type:'RuntimeDefault'}},
      containers:[{name:'kernel',image:this.image,imagePullPolicy:'IfNotPresent',command,
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'2Gi'}},
        volumeMounts:[{name:'tmp',mountPath:'/tmp'}],
      }],volumes:[{name:'tmp',emptyDir:{sizeLimit:'64Mi'}}],
    }};
  }
  async verify(namespace: string) {
    const id=randomUUID().slice(0,8), target=`probe-target-${id}`, listener=`probe-listener-${id}`;
    const resources: [string,string][] = [];
    const server='from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b"ok")\nHTTPServer(("0.0.0.0",8888),H).serve_forever()';
    const probe = (ip:string)=>`import urllib.request,json\ntry:\n r=urllib.request.urlopen("http://${ip}:8888/",timeout=3);print(json.dumps({"reachable":r.status==200 and r.read(8)==b"ok"}))\nexcept Exception: print(json.dumps({"reachable":False}))`;
    const make = async (ns:string,name:string,command:string[],component:string)=>{
      await this.create(this.podObject(ns,name,command,component));resources.push([ns,name]);
    };
    try {
      await make(namespace,target,['python3','-u','-c',server],'notebook-probe');
      await make(this.gateway,listener,['python3','-u','-c',server],'notebook-gateway');
      for (const [ns,name] of [[namespace,target],[this.gateway,listener]]) await this.command(['-n',ns!,'wait',`pod/${name}`,'--for=condition=Ready','--timeout=120s']);
      const ip=((await this.json(['-n',namespace,'get','pod',target])).status as {podIP:string}).podIP;
      const gatewayIp=((await this.json(['-n',this.gateway,'get','pod',listener])).status as {podIP:string}).podIP;
      const positive=await this.probeUntilReady(ip);
      if (!positive || !(await this.probeUntilReady(gatewayIp))) throw notebookUnavailable();
      for (const [ns,name,component] of [
        [this.gateway,`wrong-pod-${id}`,'notebook-probe'],
        [namespace,`wrong-namespace-${id}`,'notebook-gateway'],
      ]) {
        await make(ns!,name!,['python3','-c',probe(ip)],component!);
        await this.command(['-n',ns!,'wait',`pod/${name}`,'--for=jsonpath={.status.phase}=Succeeded','--timeout=120s']);
        if (JSON.parse((await this.command(['-n',ns!,'logs',name!])).toString()).reachable) throw notebookUnavailable();
      }
      if (JSON.parse((await this.command(['-n',namespace,'exec',target,'--','python3','-c',probe(gatewayIp)])).toString()).reachable) throw notebookUnavailable();
    } finally {for(const [ns,name] of resources.reverse()) await this.remove(ns,'pod',name);}
  }
  private async probeUntilReady(ip: string) {
    const deadline=Date.now()+10000;
    do {
      try {const response=await fetch(`http://${ip}:8888/`,{signal:AbortSignal.timeout(1000)});if(response.status===200 && await response.text()==='ok')return true;}
      catch { /* Readiness propagation is bounded by the same deadline. */ }
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<deadline);
    return false;
  }
}
