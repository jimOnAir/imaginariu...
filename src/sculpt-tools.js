// The Sculpt tab (SculptGL): the selected object goes into the sculpt as a welded mesh in the object's coordinate
// system, and the returned shape lands back on the same mesh. The session state (which parts, welded how) lives in
// StudioScene.sculptSession and stays while the same sculpt is open.
import * as T from 'three';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {transformOf} from './animation.js';
import {meshesOf,bonesOf} from './rig-core.js';
import {weldMesh,objFromParts,parseObj,applyWelded,changedPoints,dirtyVertices,creaseNormals,maxDisplacement} from './sculpt-core.js';
const MAPS=['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap','alphaMap','bumpMap','displacementMap'];
const attrArray=a=>{if(!a.isInterleavedBufferAttribute&&a.array instanceof Float32Array&&a.itemSize===3&&!a.normalized)return a.array;const out=new Float32Array(a.count*3);for(let i=0;i<a.count;i++){out[i*3]=a.getX(i);out[i*3+1]=a.getY(i);out[i*3+2]=a.getZ(i);}return out;};
const isFx=o=>{for(let n=o;n;n=n.parent)if(n.userData?.fx)return true;return false;};
const usable=m=>m.isMesh&&!isFx(m)&&m.geometry?.attributes.position?.count>=3&&!m.geometry.morphAttributes.position;
function targetOf(s){let o=s.selected;if(!o&&s.content.children.length===1)o=s.content.children[0];if(!o||o.isBone)throw new Error('Select a model or one of its parts (not a bone).');return o;}
const downgrade=m=>{const c=m.clone();for(const k of MAPS)if(c[k])c[k]=null;c.needsUpdate=true;return c;};
export function installSculptTools(Studio){const p=Studio.prototype;
 // -> {text (OBJ), name, parts, vertices, triangles, skipped, rigged}; remembers the session for sculptApply
 p.sculptExport=function(){
  const root=targetOf(this);root.updateWorldMatrix(true,true);const inv=root.matrixWorld.clone().invert(),parts=[],session=[],v=new T.Vector3();let skipped=0,triangles=0;
  const all=meshesOf(root);
  for(const mesh of all.filter(usable)){
   const attr=mesh.geometry.attributes.position,rel=inv.clone().multiply(mesh.matrixWorld),pos=new Float32Array(attr.count*3);
   for(let i=0;i<attr.count;i++){v.fromBufferAttribute(attr,i).applyMatrix4(rel);pos[i*3]=v.x;pos[i*3+1]=v.y;pos[i*3+2]=v.z;}
   const index=mesh.geometry.index?.array||null,weld=weldMesh(pos,index);
   if(weld.count<4||!weld.faces.length){skipped++;continue;}
   parts.push({name:mesh.name||'Part',welded:weld.welded,faces:weld.faces});triangles+=weld.faces.length/3;
   session.push({uuid:mesh.uuid,name:mesh.name,map:weld.map,count:weld.count,base:weld.welded,rel:rel.elements.slice(),vertices:attr.count});
  }
  skipped+=all.length-all.filter(usable).length;
  if(!parts.length)throw new Error('The selected object has no mesh for the sculpt.');
  const rigged=bonesOf(root).length>0||all.some(m=>m.isSkinnedMesh);
  this.sculptSession={rootId:root.uuid,name:root.name||'Model',parts:session,rigged};
  return {text:objFromParts(parts),name:root.name||'Model',parts:parts.length,vertices:session.reduce((n,q)=>n+q.count,0),triangles,skipped,rigged};
 };
 // the OBJ back from the sculpt -> the shape on the same mesh (when the vertex count did not change) or a new object.
 // -> {mode:'in-place'|'replace'|'new', ...}
 p.sculptApply=function(text){
  const s=this.sculptSession;if(!s)throw new Error('Open the object in the sculpt first.');
  const parsed=parseObj(text);if(!parsed.length)throw new Error('The sculpt returned an empty mesh.');
  const root=this.content.getObjectByProperty('uuid',s.rootId);if(!root)throw new Error('The source object was removed from the scene: nowhere to return the shape.');
  const meshes=new Map(meshesOf(root).map(m=>[m.uuid,m]));
  const same=parsed.length===s.parts.length&&s.parts.every((q,i)=>meshes.has(q.uuid)&&parsed[i].positions.length/3===q.count);
  return same?applyInPlace(this,s,parsed,meshes,root):addAsObject(this,s,text,parsed,meshes,root);
 };
}
function applyInPlace(studio,s,parsed,meshes,root){
 studio.checkpoint();
 // geometry shared with copies outside this object is cloned: the edit must not change someone else's part
 const outside=new Set();studio.content.traverse(o=>{if(o.isMesh&&!meshes.has(o.uuid))outside.add(o.geometry);});
 const v=new T.Vector3(),toMesh=(array,m)=>{const out=array.slice();for(let w=0;w<out.length;w+=3){v.set(out[w],out[w+1],out[w+2]).applyMatrix4(m);out[w]=v.x;out[w+1]=v.y;out[w+2]=v.z;}return out;};
 let moved=0,points=0;
 s.parts.forEach((q,i)=>{
  const mesh=meshes.get(q.uuid);if(outside.has(mesh.geometry))mesh.geometry=mesh.geometry.clone();
  const g=mesh.geometry,attr=g.attributes.position,relInv=new T.Matrix4().fromArray(q.rel).invert();
  // the sculpt returned positions in the object's root system; the matrix saved at export converts them back to the mesh space
  const welded=toMesh(parsed[i].positions,relInv),base=toMesh(q.base,relInv),eps=new T.Box3().setFromArray(base).getSize(v).length()*1e-5+1e-12;
  const before=attrArray(attr),next=applyWelded(before,q.map,welded,base,eps),movedPoints=changedPoints(welded,base,eps),d=maxDisplacement(before,next);
  moved=Math.max(moved,d);points+=movedPoints.reduce((n,x)=>n+x,0);
  q.base=parsed[i].positions.slice();   // the next return compares against this sculpt state
  if(!d)return;
  for(let k=0;k<attr.count;k++)attr.setXYZ(k,next[k*3],next[k*3+1],next[k*3+2]);attr.needsUpdate=true;
  const normal=g.attributes.normal,index=g.index?.array||null;
  if(normal&&!normal.isInterleavedBufferAttribute&&normal.itemSize===3){const nn=creaseNormals(next,index,q.map),dirty=dirtyVertices(q.map,index,movedPoints);for(let k=0;k<dirty.length;k++)if(dirty[k])normal.setXYZ(k,nn[k*3],nn[k*3+1],nn[k*3+2]);normal.needsUpdate=true;}
  g.computeBoundingBox();g.computeBoundingSphere();
 });
 studio.box.setFromObject(studio.selected||root);studio.emit();
 return {mode:'in-place',name:s.name,moved,points,rigged:s.rigged};
}
function addAsObject(studio,s,text,parsed,meshes,root){
 const group=new T.Group(),old=[...meshes.values()],replace=!s.rigged&&!!root.parent;
 const made=[];new OBJLoader().parse(text).traverse(m=>{if(m.isMesh)made.push(m);});
 let uvLost=false;
 made.forEach((m,i)=>{
  const src=old[i]||old[0],mat=Array.isArray(src?.material)?src.material[0]:src?.material;
  m.name=parsed[i]?.name||'Sculpt '+(i+1);
  if(mat?.isMeshStandardMaterial){const copy=mat.clone();if(MAPS.some(k=>copy[k])){m.material=downgrade(copy);uvLost=true;}else m.material=copy;}   // the new mesh has no UV: texture maps of the old material are dropped
  m.castShadow=m.receiveShadow=true;m.geometry.computeVertexNormals();group.add(m);
 });
 studio.checkpoint();
 group.name=s.name+(replace?'':' sculpt');
 group.position.copy(root.position);group.quaternion.copy(root.quaternion);group.scale.copy(root.scale);
 if(!replace)group.position.x+=new T.Box3().setFromObject(root).getSize(new T.Vector3()).x+.3;   // the rigged original stays put, the sculpt goes next to it
 (root.parent||studio.content).add(group);
 if(replace){if(studio.editor.tracks[root.uuid])studio.editor.tracks[group.uuid]=studio.editor.tracks[root.uuid];studio.mixers=studio.mixers.filter(x=>x.root!==root);root.removeFromParent();delete studio.editor.tracks[root.uuid];delete studio.editor.bases[root.uuid];}
 group.userData.sculptOf=s.name;studio.editor.bases[group.uuid]=transformOf(group);studio.sculptSession=null;studio.select(group.uuid);
 return {mode:replace?'replace':'new',name:group.name,triangles:Math.round(made.reduce((n,m)=>n+(m.geometry.index?.count||m.geometry.attributes.position.count)/3,0)),uvLost,rigged:s.rigged};
}
