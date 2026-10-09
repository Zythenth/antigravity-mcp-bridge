import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {readNativeAvatars} from '../src/codex-resources.js';

function archive(files: Record<string,string>): Buffer {
  const tree: {files: Record<string,unknown>} = {files:{}}; let offset=0;
  for (const [name,value] of Object.entries(files)) {
    const parts=name.split('/'); let node=tree;
    for (const part of parts.slice(0,-1)) { node.files[part] ??= {files:{}};node=node.files[part] as typeof tree; }
    const size=Buffer.byteLength(value);node.files[parts.at(-1)!]={size,offset:String(offset)};offset+=size;
  }
  const json=Buffer.from(JSON.stringify(tree));const header=Buffer.alloc(8+Math.ceil(json.length/4)*4);header.writeUInt32LE(header.length-4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);
  const prefix=Buffer.alloc(8);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(header.length,4);
  return Buffer.concat([prefix,header,...Object.values(files).map(text=>Buffer.from(text))]);
}
async function fixture(svg='<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>') {
  const dir=await mkdtemp(path.join(os.tmpdir(),'agy-native-resources-'));const file=path.join(dir,'app.asar');
  const panel='import {Avatar as Native} from "./main.js"; function view(){return jsx(Native,{palette:"codex",seed:"id"});}';
  const main='let dark,light,palette; dark="data:image/svg+xml,'+encodeURIComponent(svg)+'";light="data:image/svg+xml,'+encodeURIComponent(svg)+'";palette=[{dark:dark,light:light}];function renderer(p){return palette[index(p.seed)].dark;}export {renderer as Avatar};';
  await writeFile(file,archive({'webview/assets/subagent-panel-fixture.js':panel,'webview/assets/main.js':main}));
  return {dir,file,async close(){const r=path.relative(path.resolve(os.tmpdir()),path.resolve(dir));assert.ok(r&& !r.startsWith('..')&&!r.includes(path.sep)&&r.startsWith('agy-native-resources-'));await rm(dir,{recursive:true,force:true});}};
}
test('native resources use parsed static SVG data without executing vendor code',async()=>{
  const f=await fixture();try{const result=await readNativeAvatars(f.file);assert.equal(result.source,'installed-codex');assert.equal(result.pairs.length,1);assert.match(result.pairs[0]!.dark,/^data:image\/svg\+xml;base64,/);assert.equal(result.pairs[0]!.dark,result.pairs[0]!.light);}finally{await f.close();}
});
test('native resource reader rejects script-bearing SVG and malformed archive ranges',async()=>{
  const f=await fixture('<svg><script>bad()</script></svg>');try{await assert.rejects(readNativeAvatars(f.file),/Unexpected native SVG/);await writeFile(f.file,Buffer.alloc(8));await assert.rejects(readNativeAvatars(f.file),/ASAR header/);}finally{await f.close();}
});
