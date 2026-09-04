import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, RESIDUAL_SATURATION } from '../src/core/Config.js';
const SLICE = NX*NZ;
const f = new VoxelField();
generateBeach(f);
const g = new Granular(f), m = new Moisture(f, g), w = new Water(f, g, m);
const cx = 128, cz = 100, col = cx + NX*cz;
console.log('RESIDUAL', RESIDUAL_SATURATION, 'shore', w.shore[col].toFixed(2),
            'terrain', f.surfaceH[col].toFixed(2), 'nappe', w.tableH[col].toFixed(2));
const prof = (label) => {
  const a = [];
  for (let d = 0; d <= 14; d += 2) {
    const y = f.topY[col] - d;
    a.push(`${d*4}cm:${(f.moisture[col + SLICE*y]/255*100).toFixed(1)}`);
  }
  console.log(label, a.join(' '));
};
prof('generation ');
for (let i = 0; i < 1800; i++) { g.step(1/60, 60000); f.flushColumns(); m.step(1/60, 0.7); w.step(1/60); f.flushColumns(); }
prof('apres 30 s');
