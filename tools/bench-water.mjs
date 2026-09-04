/**
 * Budget CPU de l'eau, sans navigateur ni WebGL.
 *
 * Mesure `Water.step(1/60)` tel que la boucle de jeu l'appelle, sur la plage
 * de depart avec l'etat de mer par defaut, humidite et sable reels. Le budget
 * est 1,5 ms en moyenne (voir docs/ARCHITECTURE.md).
 *
 *   node tools/bench-water.mjs [etat de mer = 2]
 */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';

const BUDGET_MS = 1.5;
const state = +(process.argv[2] ?? 2);

const field = new VoxelField();
generateBeach(field);
const granular = new Granular(field);
const moisture = new Moisture(field, granular);
const water = new Water(field, granular, moisture);
water.setSeaState(state);
water.initialize();

function measure(label, count, fn) {
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    fn(i);
    samples[i] = performance.now() - t;
    field.flushColumns();
  }
  samples.sort();
  let sum = 0;
  for (let i = 0; i < count; i++) sum += samples[i];
  const mean = sum / count;
  const p95 = samples[Math.min(count - 1, Math.floor(count * 0.95))];
  console.log(`${label.padEnd(30)} moyenne ${mean.toFixed(2)} ms | p95 ${p95.toFixed(2)} ms`);
  return mean;
}

// Chauffe : le JIT, les tableaux, et la mer qui trouve son regime.
for (let i = 0; i < 240; i++) { water.step(1 / 60); field.flushColumns(); }
console.log(`\nEtat de mer ${state} : ${water.stats.wetCells} cellules d eau mouillees, ` +
  `${water.substepCount} sous-pas, mur du large a d = ${water.bandWall.toFixed(2)} m`);
const mean = measure('Water.step amorti 60 Hz', 900, () => water.step(1 / 60));
measure('  dont solve() a 30 Hz', 300, () => water.solve(1 / 30));
measure('  dont syncFine()', 300, () => water.syncFine());

const mem = process.memoryUsage();
console.log(`Memoire JS utilisee            ${(mem.heapUsed / 1048576).toFixed(1)} Mio`);
const ok = mean <= BUDGET_MS;
console.log(ok
  ? `\nBudget tenu : ${mean.toFixed(2)} ms <= ${BUDGET_MS} ms.\n`
  : `\nBudget DEPASSE : ${mean.toFixed(2)} ms > ${BUDGET_MS} ms.\n`);
process.exit(ok ? 0 : 1);
