import { spawn } from 'node:child_process';
import { openSync,closeSync,existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { data, comfyDir, venvPython } from './storage.mjs';
import { pickCard, cardEnv, claimEngineCard, engineCardFor } from './gpu-pool.mjs';
import { stopOwnedPixal3d } from './pixal3d.mjs';
 let child=null;
export async function startRuntime({ pickCardFn = pickCard } = {}){
 if(child&&!child.killed)return {running:true,pid:child.pid};
 try{const res=await fetch('http://127.0.0.1:8190/system_stats',{signal:AbortSignal.timeout(1500)});if(res.ok){const v=await res.json();const owned=v.system?.argv?.includes(path.join(data,'runtime','input'));if(owned)return {running:true,reused:true};throw new Error('Port 8190 is used by another ComfyUI. Connect its address in the settings or free the port.');}}catch(e){if(e.message.startsWith('Port 8190'))throw e;}
 const comfy=comfyDir();
 const python=venvPython(comfy);
 if(!existsSync(python)||!existsSync(path.join(comfy,'main.py')))throw new Error('ComfyUI not found. Set ASTRA_COMFY_DIR or connect your own server in the settings.');
 const folders=path.join(data,'runtime');
 const yaml=path.join(folders,'models.yaml');
 await fs.writeFile(yaml,`astraforge:\n  base_path: ${JSON.stringify(path.join(data,'models').replaceAll('\\','/'))}\n  checkpoints: checkpoints\n  custom_nodes: ../runtime/custom_nodes\nexisting:\n  base_path: ${JSON.stringify(path.join(comfy,'models').replaceAll('\\','/'))}\n  checkpoints: checkpoints\n  diffusion_models: diffusion_models\n  vae: vae\n  clip: clip\n  clip_vision: clip_vision\n`);
 const args=[path.join(comfy,'main.py'),'--listen','127.0.0.1','--port','8190','--extra-model-paths-config',yaml,'--output-directory',path.join(folders,'output'),'--input-directory',path.join(folders,'input'),'--temp-directory',path.join(folders,'temp'),'--user-directory',path.join(folders,'user'),'--database-url','sqlite:///'+path.join(folders,'studio.db').replaceAll('\\','/'),'--disable-all-custom-nodes','--whitelist-custom-nodes','AstraForgeMesh','ComfyUI-MVAdapter','ComfyUI-GGUF','--lowvram','--reserve-vram','1'];
 const logFile=path.join(folders,'comfy.log'),logFd=openSync(logFile,'a');
 // The card pool picks at spawn and the engine stays on it until it exits (torch cannot be
 // moved): free card first, otherwise the most suitable busy one (the per-card lock and the
 // hand-over serialize it), otherwise no pin at all (no pool - the pre-pool behaviour).
 const claimed=[engineCardFor('pixal3d')].filter(Boolean);
 const card=pickCardFn({engine:'hunyuan',claimed})||pickCardFn({engine:'hunyuan',claimed,free:false});
 claimEngineCard('hunyuan',card);
 try{child=spawn(python,args,{cwd:comfy,windowsHide:true,detached:true,stdio:['ignore',logFd,logFd],env:cardEnv(card,{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'})});child.unref();}finally{closeSync(logFd);}
 await fs.writeFile(path.join(folders,'comfy.pid'),String(child.pid));
 child.on('error',e=>{void fs.appendFile(logFile,e.message+'\n').catch(()=>{});child=null;claimEngineCard('hunyuan',null);});child.on('exit',()=>{child=null;claimEngineCard('hunyuan',null);});
 return {running:true,pid:child.pid};
}
export function stopOwnedRuntime(){stopOwnedPixal3d();if(child){if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();}}
// Restart of the generation service (behavior per ADR-0004, ticket 06). The child this studio
// spawned is killed and the service comes back on the same folders; an instance that was only
// reused (started by its owner elsewhere) is never killed - the answer says so; nothing running
// is simply started. The port is polled until it goes quiet before the spawn, so the new
// ComfyUI never fights the dying one, and the kill waits for 'exit' (or 10 s) to keep the pid file honest.
export async function restartRuntime(){
 if(child){
  const old=child;
  await new Promise((done)=>{const t=setTimeout(done,10000);old.once('exit',()=>{clearTimeout(t);done();});try{old.kill();}catch{clearTimeout(t);done();}});
 }
 for(let i=0;i<20;i++){
  let awake=false;
  try{const r=await fetch('http://127.0.0.1:8190/system_stats',{signal:AbortSignal.timeout(600)});awake=r.ok;}catch{/* refused: port free */}
  if(!awake)break;
  await new Promise((r)=>setTimeout(r,500));
 }
 const res=await startRuntime();
 if(res.reused)return {running:true,restarted:false,external:true,note:'The ComfyUI on port 8190 was started outside this studio; it is left running untouched - restart it the way it was started.'};
 return {running:true,restarted:true,pid:res.pid};
}
