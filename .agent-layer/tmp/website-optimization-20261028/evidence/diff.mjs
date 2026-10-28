import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=path.dirname(new URL(import.meta.url).pathname);
const require=createRequire(path.join(root,'worktree/package.json'));
const sharp=require('sharp');sharp.concurrency(1);
const dir=path.join(root,'screenshots');const out=path.join(root,'comparisons');await fs.mkdir(out,{recursive:true});
const summaries=[];
for(const name of (await fs.readdir(dir)).filter(n=>n.startsWith('base-')&&n.endsWith('.png'))){
 const counterpart=name.replace(/^base-/,'worktree-');
 const a=await sharp(path.join(dir,name)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const b=await sharp(path.join(dir,counterpart)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 if(a.info.width!==b.info.width||a.info.height!==b.info.height)throw Error(`Dimension difference ${name}`);
 const {width,height}=a.info;const diff=Buffer.alloc(width*height*4),overlay=Buffer.alloc(width*height*4);
 let differingPixels=0,maxChannelDelta=0;
 for(let i=0;i<a.data.length;i+=4){
  const delta=Math.max(...[0,1,2,3].map(c=>Math.abs(a.data[i+c]-b.data[i+c])));
  if(delta){differingPixels++;maxChannelDelta=Math.max(maxChannelDelta,delta);}
  diff[i]=delta?255:0;diff[i+1]=0;diff[i+2]=delta?255:0;diff[i+3]=255;
  overlay[i]=delta?255:Math.round((a.data[i]+b.data[i])/2);overlay[i+1]=delta?0:Math.round((a.data[i+1]+b.data[i+1])/2);overlay[i+2]=delta?255:Math.round((a.data[i+2]+b.data[i+2])/2);overlay[i+3]=255;
 }
 const stem=name.replace(/^base-/,'').replace(/\.png$/,'');
 await sharp(diff,{raw:{width,height,channels:4}}).png().toFile(path.join(out,`${stem}-diff.png`));
 await sharp(overlay,{raw:{width,height,channels:4}}).png().toFile(path.join(out,`${stem}-overlay.png`));
 await sharp({create:{width:width*2,height,channels:4,background:'#ffffff'}}).composite([{input:path.join(dir,name),left:0,top:0},{input:path.join(dir,counterpart),left:width,top:0}]).png().toFile(path.join(out,`${stem}-before-after.png`));
 summaries.push({name:stem,width,height,totalPixels:width*height,differingPixels,maxChannelDelta,before:`screenshots/${name}`,after:`screenshots/${counterpart}`,comparison:`comparisons/${stem}-before-after.png`,diff:`comparisons/${stem}-diff.png`,overlay:`comparisons/${stem}-overlay.png`});
}
await fs.writeFile(path.join(root,'visual-diffs.json'),JSON.stringify(summaries,null,2)+'\n');
console.log(JSON.stringify(summaries.map(({name,differingPixels,maxChannelDelta})=>({name,differingPixels,maxChannelDelta})),null,2));
if(summaries.some(s=>s.differingPixels))process.exitCode=1;
