import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const data=path.join(root,'data');
// ComfyUI install used for its Python (.venv) and main.py: env ASTRA_COMFY_DIR, else <app>/runtime/ComfyUI
export const comfyDir=()=>process.env.ASTRA_COMFY_DIR||path.join(root,'runtime','ComfyUI');
// Python of the ComfyUI venv: Windows layout Scripts/python.exe, POSIX layout bin/python.
export const venvPython=(comfy=comfyDir())=>path.join(comfy,'.venv',process.platform==='win32'?path.join('Scripts','python.exe'):path.join('bin','python'));
export async function init(){for(const folder of ['assets','exports','projects','jobs','runtime','runtime/input','runtime/output','runtime/temp','runtime/user'])await fs.mkdir(path.join(data,folder),{recursive:true});}
// A leading UTF-8 BOM is cut: config files written by Windows PowerShell 5.1 (Set-Content -Encoding UTF8)
// carry one, and before 0.4.11 the studio refused to start over such data/config.json (user report 01.11.2026).
export const parseJson=text=>JSON.parse(String(text).replace(/^\uFEFF/,''));
export async function readJson(file,fallback){try{return parseJson(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function writeJson(file,value){const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2));await fs.rename(temp,file);}
export const isId=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export async function saveAsset(buffer,extension,name){const id=randomUUID();await fs.writeFile(path.join(data,'assets',id+extension),buffer);const info={id,extension,name:name||'Asset',url:'/api/assets/'+id};await writeJson(path.join(data,'assets',id+'.json'),info);return info;}
export async function assetInfo(id){if(!isId(id))throw Object.assign(new Error('Invalid ID'),{status:400});const info=await readJson(path.join(data,'assets',id+'.json'),null);if(!info)throw Object.assign(new Error('File not found'),{status:404});return info;}
