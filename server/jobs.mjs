import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { data,readJson,writeJson,assetInfo,saveAsset,isId } from './storage.mjs';
import { hunyuanWorkflow,hunyuanMultiViewWorkflow,MV_CHECKPOINT,sdxlWorkflow } from './schema.mjs';
import { isLowVram,currentVramMib } from './low-vram.mjs';
import {getViewsService} from './views.mjs';
import WebSocket from 'ws';
import { conceptEnglishText } from './concept-llm.mjs';   // ticket 60 item 6: the no-assistant fallback lives there
import { prepareConcept, conceptPrepPythonCheck } from './preprocess.mjs';
import {validateGeneratedMesh,maxMeshBytes} from './mesh-validation.mjs';
import {acceptOrSimplify,makeSalvageSimplify} from './mesh-salvage.mjs';
import {acquireEngineGpu} from './gpu-handover.mjs';
import {pickCard,engineCardFor,cardLockName} from './gpu-pool.mjs';
import {pixal3dConfig,pixal3dStatus} from './pixal3d.mjs';
import {generatePixal3d} from './pixal3d-run.mjs';
import {triposgStatus,generateTripoSG} from './triposg.mjs';
const jobs=new Map();const controllers=new Map();let active=null;let pumping=false;
// Auto-review (ticket 08): index.mjs installs a listener; a completed shape job is its only caller.
// The studio's own retry children carry autoreviewOf and must not open a second review.
export const hooks={onCompleted:null};
// Ticket 34 (0.6.18 wave): an over-cap but valid generation is simplified to the limit (the
// branch's own Blender cleanup decimate path) instead of the job failing and the asset being lost.
// Ticket 46 (0.7.9 performance wave): the chain prefers af-mesh-rs (seconds, attributes carried)
// and keeps Blender as the fallback and the ASTRA_SALVAGE=blender forced route.
const simplifyMesh=makeSalvageSimplify();
async function validateGlbAsset(buffer,j,file){
 const {validation,simplifiedBuffer}=await acceptOrSimplify(buffer,{meshLevel:j?.meshLevel??0,simplify:simplifyMesh});
 if(simplifiedBuffer)await fs.writeFile(file,simplifiedBuffer);
 return validation;
}
const simplifyNote=v=>v.simplifiedFrom?' · simplified from '+(v.simplifiedFrom/1e6).toFixed(1)+' M triangles':'';
// Startup job load (behavior per ADR-0004, ticket 02): a job file that is empty, truncated,
// BOM-garbled or otherwise unparseable is moved to jobs/broken/ and skipped instead of taking
// the whole studio down; a file that parses but is not a job record (no uuid id, not an object)
// is quarantined the same way. The recovered-queue flip writes back to the file it was read
// from, never through persist() - loading a foreign folder must not write into live data.
export async function loadJobs(dir=path.join(data,'jobs'),warn=(m)=>console.warn(m)){
 let quarantined=0;
 const broken=()=>path.join(dir,'broken');
 for(const file of await fs.readdir(dir)){
  if(!file.endsWith('.json')||file==='broken')continue;
  const full=path.join(dir,file);
  let j=null;
  try{j=await readJson(full,null);}
  catch(e){await fs.mkdir(broken(),{recursive:true});try{await fs.rename(full,path.join(broken(),file));quarantined++;warn('jobs: '+file+' is not readable ('+e.name+'), moved to jobs/broken/');}catch(re){warn('jobs: '+file+' is not readable and could not be moved: '+(re.code||re.message));}continue;}
  if(j===null)continue; // the file vanished between readdir and read
  if(typeof j!=='object'||Array.isArray(j)||!isId(j.id)){await fs.mkdir(broken(),{recursive:true});try{await fs.rename(full,path.join(broken(),file));quarantined++;warn('jobs: '+file+' is not a job record, moved to jobs/broken/');}catch(re){warn('jobs: '+file+' is not a job record and could not be moved: '+(re.code||re.message));}continue;}
  if(['queued','running'].includes(j.status)){j.status='failed';j.message='The job was interrupted by a restart. Start the generation again.';await writeJson(full,j);}
  jobs.set(j.id,j);
 }
 return quarantined;
}
const writes=new Map();
const persist=j=>{const next=(writes.get(j.id)||Promise.resolve()).catch(()=>{}).then(()=>writeJson(path.join(data,'jobs',j.id+'.json'),j));writes.set(j.id,next);return next;};
async function update(j,values){Object.assign(j,values,{updatedAt:new Date().toISOString()});await persist(j);}
export const allJobs=()=>[...jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
export function getJob(id){return jobs.get(id);}
export async function validateJobMesh(id){const j=jobs.get(id);if(!j?.asset||j.asset.extension!=='.glb')throw new Error('The job has no GLB to validate.');try{const info=await assetInfo(j.asset.id),file=path.join(data,'assets',info.id+info.extension);const validation=await validateGlbAsset(await fs.readFile(file),j,file);await update(j,{validation});return validation;}catch(e){await update(j,{status:'failed',message:e.message,validation:{accepted:false,reason:e.message}});return j.validation;}}
export async function createJob(input,config){const j={id:randomUUID(),...input,status:'queued',progress:0,message:'Waiting in the queue',createdAt:new Date().toISOString()};jobs.set(j.id,j);await persist(j);void pump(config);return j;}
export async function cancelJob(id,config){const j=jobs.get(id);if(!j)return;if(!['queued','running'].includes(j.status))return;controllers.get(id)?.abort();if(j.promptId&&j.engine!=='pixal3d'){const queue=await jsonFetch(config.comfyUrl+'/queue').catch(()=>null);if(queue?.queue_running?.some(item=>item[1]===j.promptId))await fetch(config.comfyUrl+'/interrupt',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});else await fetch(config.comfyUrl+'/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:[j.promptId]})}).catch(()=>{});}await update(j,{status:'cancelled',message:'Cancelled'});}
async function pump(config){if(pumping)return;pumping=true;try{for(;;){const j=[...jobs.values()].find(x=>x.status==='queued');if(!j)break;active=j.id;const controller=new AbortController();controllers.set(j.id,controller);try{await run(j,config,controller.signal);}catch(e){if(j.status!=='cancelled')await update(j,{status:'failed',message:e.name==='AbortError'?'Generation aborted':e.message});}finally{controllers.delete(j.id);active=null;if(j.status==='completed'&&j.asset?.extension==='.glb'&&!j.autoreviewOf&&hooks.onCompleted)void Promise.resolve(hooks.onCompleted(j)).catch(()=>{});}}}finally{pumping=false;}}
async function jsonFetch(url,options={}){const res=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(10000)});let v;try{v=await res.json();}catch{throw new Error('The ComfyUI server returned an invalid response.');}if(!res.ok)throw new Error(v.error?.message||JSON.stringify(v.node_errors||v.error||v).slice(0,700));return v;}
async function waitPrompt(j,config,workflow,signal,stage){
 let nodeClass='';const clientId=randomUUID();const socket=new WebSocket(config.comfyUrl.replace('http:','ws:')+'/ws?clientId='+clientId);
 socket.on('error',()=>{});
 socket.on('message',raw=>{try{const v=JSON.parse(raw);if(j.status!=='running'||(v.data?.prompt_id&&j.promptId&&v.data.prompt_id!==j.promptId))return;if(v.type==='progress'){const ratio=v.data.value/v.data.max,meshPhase=['VAEDecodeHunyuan3D','VoxelToMesh','AstraMarchingCubes','SaveGLB'].includes(nodeClass);void update(j,{progress:meshPhase?Math.min(98,Math.round(88+ratio*10)):Math.min(87,Math.round(ratio*87)),message:(meshPhase?'Extracting the mesh':stage)+' · '+v.data.value+'/'+v.data.max}).catch(()=>{});}if(v.type==='executing'&&v.data.node){const node=workflow[v.data.node]?.class_type;nodeClass=node;const phases={VAEDecodeHunyuan3D:[88,'Extracting the volume from the latent'],VoxelToMesh:[94,'Building the polygon mesh'],AstraMarchingCubes:[94,'Extracting the surface · Marching Cubes'],SaveGLB:[97,'Saving GLB']};if(phases[node])void update(j,{progress:phases[node][0],message:phases[node][1]}).catch(()=>{});}}catch{}});
 const gpu=await acquireEngineGpu('hunyuan',{signal,failOpen:true,timeoutMs:60*60*1000,name:cardLockName(engineCardFor('hunyuan'))||undefined,urls:{hunyuan:config.comfyUrl},onWait:()=>void update(j,{message:'Waiting for the GPU to become free (GPU lock)'}).catch(()=>{}),onStep:text=>void update(j,{message:text}).catch(()=>{})}).catch(e=>{socket.close();throw e;});
 const deadline=Date.now()+60*60*1000;
 if(gpu.handover?.freed?.length||gpu.handover?.waited)void update(j,{handover:gpu.handover}).catch(()=>{});
 try{
  const queued=await jsonFetch(config.comfyUrl+'/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:workflow,client_id:clientId}),signal});await update(j,{promptId:queued.prompt_id});
  while(Date.now()<deadline){signal.throwIfAborted();const history=await jsonFetch(config.comfyUrl+'/history/'+queued.prompt_id,{signal});const h=history[queued.prompt_id];
   if(h){const error=h.status?.messages?.find(x=>x[0]==='execution_error');if(error)throw new Error((error[1]?.exception_message||'Engine error').slice(0,900));if(h.status?.status_str==='error')throw new Error('ComfyUI failed to run the generation. Check runtime/comfy.log.');if(h.status?.completed)return h.outputs;}
   await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{done();reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{done();resolve();},1500);signal.addEventListener('abort',abort,{once:true});});
  }throw new Error('Generation timed out (60 minutes).');
 }finally{socket.close();await gpu.release();}
}
async function downloadOutput(config,item,extension,name){const params=new URLSearchParams({filename:item.filename,subfolder:item.subfolder||'',type:item.type||'output'});const r=await fetch(config.comfyUrl+'/view?'+params,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('Failed to get the generation result.');if(Number(r.headers.get('content-length'))>maxMeshBytes){await r.body.cancel();throw new Error('The result exceeds 100 MB. Check the surface settings.');}const reader=r.body.getReader(),chunks=[];let length=0;for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxMeshBytes){await reader.cancel();throw new Error('The result exceeds 100 MB.');}chunks.push(Buffer.from(value));}const buffer=Buffer.concat(chunks);if(extension==='.glb'){try{validateGeneratedMesh(buffer);}catch(e){if(e.code!=='oversize')throw e;}}return saveAsset(buffer,extension,name);}
// View-set images -> ComfyUI input. The names depend on the set and its revision: a retry with a different surface level hits the engine cache.
async function uploadViews(j,config,signal){
 const set=await getViewsService().forJob(j.viewSetId,{signal}),stamp=String(set.rev||'').replace(/[^0-9]/g,'').slice(-12),uploaded={};
 for(const [slot,file] of Object.entries(set.files)){const form=new FormData();form.append('image',new Blob([await fs.readFile(file)]),'astra-vs-'+j.viewSetId.slice(0,8)+'-'+stamp+'-'+slot+'.png');form.append('overwrite','true');uploaded[slot]=(await jsonFetch(config.comfyUrl+'/upload/image',{method:'POST',body:form,signal})).name;}
 await update(j,{viewSlots:Object.keys(uploaded)});return uploaded;
}
// Text -> concept image with SDXL in the Hunyuan ComfyUI (shared by both 3D engines). Returns the asset id of the concept.
async function conceptFromPrompt(j,config,signal,nodes){
  const cp=nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]||[];if(!cp.includes(config.imageCheckpoint))throw new Error('Text input requires an installed SDXL checkpoint.');
  let englishPrompt=j.prompt;
  if(/[^\x00-\x7F]/.test(j.prompt)){
   await update(j,{message:'Translating the concept with the local LLM',progress:0});
   // a missing assistant draws the concept from the text as written and says so (concept-llm.mjs)
   const tr=await conceptEnglishText(j.prompt,{config,signal,note:async(message)=>{await update(j,{conceptNote:message});}});signal.throwIfAborted();
   englishPrompt=tr.english;if(!tr.untranslated)await update(j,{englishPrompt});
  }
  await update(j,{message:'Creating the concept image · SDXL',progress:0});
  const outputs=await waitPrompt(j,config,sdxlWorkflow(englishPrompt,config.imageCheckpoint,j.seed,'astra/'+j.id),signal,'Concept image');
  const item=Object.values(outputs).flatMap(x=>x.images||[])[0];if(!item)throw new Error('SDXL did not return an image.');
  const img=await downloadOutput(config,item,'.png','Concept');await update(j,{concept:img});return img.id;
}
// Pixal3D (docs/forge/pixal3d.md): the same job record as Hunyuan, the geometry comes from the separate ComfyUI-Pixal3D on 8191.
// 0.7.4 fold wave ticket 57: the up-front capability row every Pixal3D job runs FIRST. The engine
// install state and the concept-prep python are named here, before any wait for a concept - a
// missing engine Python used to surface only after the SDXL concept had been generated. The
// sentences are the engine-state text and the venv-health text of ticket 25; no new strings.
export async function pixal3dPreflight() {
 const cfg=pixal3dConfig(),state=await pixal3dStatus({cfg});
 if(!state.installed)throw new Error(state.message);
 const missing=conceptPrepPythonCheck();
 if(missing)throw new Error(missing);
 return {cfg,state};
}
async function runPixal3d(j,config,signal){
 await update(j,{status:'running',message:'Checking the Pixal3D engine',progress:0});
 const {cfg}=await pixal3dPreflight();
 if(j.reextractSourceId)throw new Error('Surface re-extraction is available for Hunyuan3D only.');
 let image=j.imageId;
 if(!image){
  let nodes;try{nodes=await jsonFetch(config.comfyUrl+'/object_info',{signal});}catch{throw new Error('A text description needs the local SDXL engine (port 8190). Open the connections and click "Start 3D engine", or upload a concept image.');}
  image=await conceptFromPrompt(j,config,signal,nodes);
 }
 await update(j,{engineUrl:cfg.url,modelCheckpoint:'TencentARC/Pixal3D'});
 let prepared=null;
 if(image){await update(j,{message:'Removing the background and centering the concept · CPU',progress:0});prepared=await prepareConcept(image,j.id,signal,j.backgroundMode||'auto');await update(j,{preparedConcept:prepared});}
 let images,removeBackground=false;
 if(j.viewSetId){
  await update(j,{message:'Preparing views for Pixal3D',progress:0});
  const set=await getViewsService().forJob(j.viewSetId,{signal});
  images=set.cutFiles;if(!images?.front)throw new Error('The set has no cut-out front view. Open the "Views" block and wait for the views to be prepared.');
  await update(j,{viewSlots:Object.keys(images)});
 }else{
  if(!prepared)throw new Error('A concept image or a description is required.');
  const info=await assetInfo(prepared.reference.id);images={front:path.join(data,'assets',info.id+info.extension)};
  removeBackground=String(j.backgroundMode||'').startsWith('keep');
 }
 const result=await generatePixal3d({images,seed:j.seed,tag:j.id.slice(0,8),signal,removeBackground,cfg,
  onProgress:({percent,message})=>{if(j.status==='running')void update(j,{progress:percent,message}).catch(()=>{});},
  onPrompt:promptId=>void update(j,{promptId}).catch(()=>{}),
  onWait:message=>{if(j.status==='running')void update(j,{message}).catch(()=>{});}});
 signal.throwIfAborted();
 const asset=await saveAsset(result.buffer,'.glb',j.viewSetId?'Pixal3D · from views':'Pixal3D · '+(j.prompt||'from image').slice(0,50));
 const validation=await validateGlbAsset(result.buffer,j,path.join(data,'assets',asset.id+asset.extension));
 await update(j,{status:'completed',progress:100,message:'Geometry created · Pixal3D'+simplifyNote(validation)+' · needs review',asset,validation,pixal3d:{seconds:result.seconds,slots:result.slots,targetFaces:result.targetFaces,vramPeakMb:result.vram?.peak_used_mb??null,vramBaselineMb:result.vram?.baseline_used_mb??null,scale:result.normalization.scale,handover:result.handover}});
}
// TripoSG (docs/product/triposg.md): the third shape engine - one concept in, GLB out, through a
// one-shot venv worker instead of a service (ADR-0004 ticket 01). Same job record as its siblings.
async function runTripoSG(j,config,signal){
 await update(j,{status:'running',message:'Checking the TripoSG engine',progress:0});
 const state=triposgStatus();
 if(!state.installed)throw new Error(state.message);
 if(j.reextractSourceId)throw new Error('Surface re-extraction is available for Hunyuan3D only.');
 if(j.viewSetId)throw new Error('TripoSG shapes a single concept image; a view set stays with Hunyuan3D or Pixal3D.');
 let image=j.imageId;
 if(!image){
  let nodes;try{nodes=await jsonFetch(config.comfyUrl+'/object_info',{signal});}catch{throw new Error('A text description needs the local SDXL engine (port 8190). Open the connections and click "Start 3D engine", or upload a concept image.');}
  image=await conceptFromPrompt(j,config,signal,nodes);
 }
 if(String(j.backgroundMode||'')==='keep')throw new Error('TripoSG always cuts the concept out; "keep the background" is a Hunyuan3D and Pixal3D option.');
 await update(j,{modelCheckpoint:'VAST-AI/TripoSG (MIT)'});
 await update(j,{message:'Removing the background and centering the concept · CPU',progress:0});
 const prepared=await prepareConcept(image,j.id,signal,j.backgroundMode||'auto');
 await update(j,{preparedConcept:prepared});
 const info=await assetInfo(prepared.reference.id);
 // 0.7.11: TripoSG used to rely on the job pump alone for serialization - with parallel dispatch
 // that is not true any more. The one-shot worker gets its card from the pool (the other
 // engines' claims are never offered) and holds that card's lock for the whole run.
 const claimed=[engineCardFor('hunyuan'),engineCardFor('pixal3d')].filter(Boolean);
 const card=pickCard({engine:'triposg',claimed})||pickCard({engine:'triposg',claimed,free:false});
 const gpu=await acquireEngineGpu('triposg',{signal,failOpen:true,timeoutMs:60*60*1000,name:cardLockName(card)||undefined,card,onWait:m=>void update(j,{message:m}).catch(()=>{}),onStep:m=>void update(j,{message:m}).catch(()=>{})});
 let result;
 try{result=await generateTripoSG({image:path.join(data,'assets',info.id+info.extension),level:j.meshLevel??0,seed:j.seed,signal,card,
  onProgress:({percent,message})=>{if(j.status==='running')void update(j,{progress:percent,message}).catch(()=>{});},
  onWait:message=>{if(j.status==='running')void update(j,{message}).catch(()=>{});}});}
 finally{await gpu.release();}
 signal.throwIfAborted();
 const asset=await saveAsset(result.buffer,'.glb',('TripoSG · '+(j.prompt||'from image')).slice(0,50));
 const validation=await validateGlbAsset(result.buffer,j,path.join(data,'assets',asset.id+asset.extension));
 await update(j,{status:'completed',progress:100,message:'Geometry created · TripoSG'+simplifyNote(validation)+' · needs review',asset,validation,triposg:{seconds:result.stats.seconds,faces:result.stats.faces,facesTarget:result.stats.facesTarget,seed:result.stats.seed,warnings:result.stats.warnings}});
}
const MINI_CHECKPOINT='hunyuan3d-dit-v2-mini.safetensors';
// Ticket 54 (0.7.4 fold): shapeModel -> the checkpoint file. 'auto' is the small-card pick:
// Hunyuan3D-2mini when its file is installed and the branch's one low-VRAM seam (9216 MiB,
// ticket 37 - no second number) says the card is too small for the 2.0 DiT. 'default' stays
// byte-for-byte the pre-0.7.9 behaviour (the configured checkpoint); an unknown card (null
// VRAM) is "not small" (ticket 33's honesty), so auto never picks mini on faith.
export function pickShapeCheckpoint(shapeModel,{names=[],fallback,vramMib}={}){
 if(shapeModel==='hunyuan21')return 'hunyuan_3d_v2.1.safetensors';
 if(shapeModel==='hunyuan2mini')return MINI_CHECKPOINT;
 if(shapeModel==='auto'&&names.includes(MINI_CHECKPOINT)&&isLowVram(vramMib))return MINI_CHECKPOINT;
 return fallback;
}

async function run(j,config,signal){
 if(j.engine==='pixal3d')return runPixal3d(j,config,signal);
 if(j.engine==='triposg')return runTripoSG(j,config,signal);
 await update(j,{status:'running',message:'Checking the 3D engine',progress:0});
 let nodes;try{nodes=await jsonFetch(config.comfyUrl+'/object_info',{signal});}catch{throw new Error('The local 3D engine is not running. Open the connections and click "Start 3D engine".');}
 const names=nodes.ImageOnlyCheckpointLoader?.input?.required?.ckpt_name?.[0]||[],checkpoint=j.viewSetId?MV_CHECKPOINT:pickShapeCheckpoint(j.shapeModel,{names,fallback:config.shapeCheckpoint,vramMib:currentVramMib({refresh:true})});
 if(!names.includes(checkpoint))throw new Error(j.viewSetId?'Geometry from views requires the model '+MV_CHECKPOINT+' (Hunyuan3D-2mv). It is not installed or is still downloading.':'The selected Hunyuan3D model is not installed or is still downloading. Check the connections.');
 await update(j,{modelCheckpoint:checkpoint});
 for(const node of [j.viewSetId?'Hunyuan3Dv2ConditioningMultiView':'Hunyuan3Dv2Conditioning','SaveGLB','AstraMarchingCubes'])if(!nodes[node])throw new Error('ComfyUI is missing the node '+node+'. Start the AstraForge 3D engine on port 8190.');
 let image=j.imageId;
 if(!image&&!j.reextractSourceId)image=await conceptFromPrompt(j,config,signal,nodes);
 let prepared,geometryImage;
 if(j.reextractSourceId){const source=jobs.get(j.reextractSourceId);if(!source?.preparedConcept||!source.promptId)throw new Error('There is no saved geometry source.');const history=await jsonFetch(config.comfyUrl+'/history/'+source.promptId,{signal}),workflow=history[source.promptId]?.prompt?.[2],geometrySourceId=source.geometrySourceId||source.id;geometryImage=source.geometryImage||workflow?.['2']?.inputs?.image||("astra-"+geometrySourceId+".png");if(typeof geometryImage!=='string'||geometryImage!=='astra-'+geometrySourceId+'.png')throw new Error('The source is missing from the cache. Repeat the generation from the image.');await fs.access(path.join(data,"runtime","input",geometryImage));prepared=source.preparedConcept;await update(j,{preparedConcept:prepared,message:'Re-extracting the mesh · saved input',geometryImage,geometrySourceId});}
 else{await update(j,{message:'Removing the background and centering the concept · CPU',progress:0});prepared=await prepareConcept(image,j.id,signal,j.backgroundMode||'auto');await update(j,{preparedConcept:prepared});const info=await assetInfo(prepared.id);const buffer=await fs.readFile(path.join(data,'assets',info.id+info.extension));const form=new FormData();form.append('image',new Blob([buffer]),'astra-'+j.id+info.extension);form.append('overwrite','true');const uploaded=await jsonFetch(config.comfyUrl+'/upload/image',{method:'POST',body:form,signal});geometryImage=uploaded.name;await update(j,{geometryImage});}
 let viewImages=null;
 if(j.viewSetId){await update(j,{message:'Preparing views for Hunyuan3D-2mv',progress:0});viewImages=await uploadViews(j,config,signal);}
 await update(j,{message:viewImages?'Creating geometry from views · Hunyuan3D-2mv ('+Object.keys(viewImages).length+' views)':'Creating geometry · Hunyuan3D',progress:0});
 const outputs=await waitPrompt(j,config,viewImages?hunyuanMultiViewWorkflow(viewImages,checkpoint,j.quality,j.seed,'astra/'+j.id,j.meshLevel??0):hunyuanWorkflow(geometryImage,checkpoint,j.quality,j.seed,'astra/'+j.id,j.meshLevel??0),signal,viewImages?'Geometry from views':'Geometry');signal.throwIfAborted();
 const item=Object.values(outputs).flatMap(x=>x['3d']||[])[0];if(!item)throw new Error('The engine did not return a GLB.');
 const asset=await downloadOutput(config,item,'.glb',(j.viewSetId?'Hunyuan3D-2mv · from views':'Hunyuan3D · '+j.prompt.slice(0,50)));const assetFile=path.join(data,'assets',asset.id+asset.extension);const validation=await validateGlbAsset(await fs.readFile(assetFile),j,assetFile);await update(j,{status:'completed',progress:100,message:'Geometry created'+simplifyNote(validation)+' · needs review',asset,validation});
}
