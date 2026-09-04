import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { NX, NY, NZ, ISO } from '../src/core/Config.js';
import { maxDropByte } from '../src/sim/SandPhysics.js';
const SLICE=NX*NZ, CX=NX>>1, CZ=NZ>>1;
const f=new VoxelField();
const set=(x,y,z,w,p)=>{const i=x+NX*(z+NZ*y);f.density[i]=255;f.moisture[i]=Math.round(w*255);f.packing[i]=Math.round(p*255);f.material[i]=1;};
for(let y=0;y<6;y++)for(let z=0;z<NZ;z++)for(let x=0;x<NX;x++)set(x,y,z,0.035,0.5);
const H=30;
for(let y=6;y<6+H;y++)for(let dz=-1;dz<=1;dz++)for(let x=CX-14;x<=CX+14;x++)set(x,y,CZ+dz,0.035,0.6);
f.rebuildAll();
const g=new Granular(f);
g.wakeBox(CX-17,5,CZ-4,CX+17,6+H+2,CZ+4);
const i=CX+NX*(CZ+NZ*35);
console.log('crete: dens',f.density[i],'m',f.moisture[i],'pk',f.packing[i],
            'maxDrop',maxDropByte(f.moisture[i],f.packing[i]).toFixed(2));
console.log('above', f.density[i+SLICE], 'below', f.density[i-SLICE]);
console.log('hSelf', g.localHeight(CX,CZ,35).toFixed(2),
            'hVoisin(z+2)', g.localHeight(CX,CZ+2,35).toFixed(2));
console.log('movable', g.movable(i));
const crest = CX+NX*((CZ+1)+NZ*35);
for(let s=1;s<=2500;s++){
  g.step(1/60,400000); f.flushColumns();
  if(s<=8){
    console.log(`s=${s} actifs=${g.stats.active} traites=${g.stats.processed} deplaces=${g.stats.moved}`
      +` crete=${f.density[crest]} flag=${g.flag[crest]}`
      +` hSelf=${g.localHeight(CX,CZ+1,35).toFixed(2)}`
      +` hVois=${g.localHeight(CX,CZ+2,35).toFixed(2)}`);
  }
  if(s===1||s===50||s===300||s===1200||s===2500){
    let top=-1; for(let y=NY-1;y>=0;y--) if(f.density[CX+NX*(CZ+NZ*y)]>=ISO){top=y;break;}
    console.log(`s=${s} top=${top} actifs=${g.stats.active} traites=${g.stats.processed} deplaces=${g.stats.moved}`);
  }
}
