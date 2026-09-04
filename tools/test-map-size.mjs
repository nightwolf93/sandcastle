/**
 * Test d'une carte d'une autre taille, non carree : 416 x 224 voxels
 * (16,6 m x 9 m). La taille est lue par Config.js au chargement, ici par
 * le canal des workers (`self.name`), avant tout import dynamique. Tout ce
 * qui derive de NX/NZ (chunks, grille d'eau, generation, solveur) doit
 * suivre sans hypothese cachee de carte carree.
 */
globalThis.self = { name: 'map:416x224' };

const Config = await import('../src/core/Config.js');
const { NX, NY, NZ, CHUNK_COUNT, WATER_NX, WATER_NZ, WORLD_W, WORLD_D } = Config;
const { VoxelField } = await import('../src/sim/VoxelField.js');
const { Water } = await import('../src/sim/Water.js');
const { generateBeach, shoreRange, applyBeachStyle } = await import('../src/world/BeachGenerator.js');
const { EditContext, stampSandBox } = await import('../src/tools/Brush.js');
const { buildWaterShaders } = await import('../src/sim/WaterGPU.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const stub = { push() {}, wake() {}, wakeBox() {} };

console.log('\n== Carte 416 x 224 ==');
check('les constantes suivent la taille demandee', NX === 416 && NZ === 224 && NY === 96);
check('les chunks aussi', CHUNK_COUNT === 13 * 7 * 3, `${CHUNK_COUNT}`);
check('la grille d eau aussi', WATER_NX === 208 && WATER_NZ === 112);
check('le monde fait 16,6 m x 9 m', Math.abs(WORLD_W - 16.64) < 1e-9 && Math.abs(WORLD_D - 8.96) < 1e-9);
const r = shoreRange();
check('le rivage reste a deux metres des bords', Math.abs(r.min + 2.48) < 1e-9 && Math.abs(r.max - 2.48) < 1e-9);

const field = new VoxelField();
check('le champ voxel a la bonne taille', field.density.length === NX * NY * NZ);
const beach = generateBeach(field, 11, 'lagon');
check('un lagon se genere sur une carte etroite', beach.heights.length === NX * NZ && beach.style === 'lagon');
const applied = applyBeachStyle('lagon');
check('l avant-plage du lagon est bornee a la mer disponible', applied.foreshore <= WORLD_D / 2 - applied.shoreC - 0.4 + 1e-9, `${applied.foreshore.toFixed(2)} m`);

const water = new Water(field, stub, null);
water.setDamage(2); water.tideSpeed = 1;
water.waves.setCustom(0.30, 0.6);
water.initialize();
check('la mer s installe', water.stats.wetCells > 800, `${water.stats.wetCells} cellules`);
const ctx = new EditContext(field, stub, { touchBox() {} }, water, null);
stampSandBox(ctx, 0, field.surfaceHeightAt(0, r.min + 0.5), r.min + 0.5, 0.6, 0.3, 0.4, 0.3, 0.12, 0.95);
let finite = true;
for (let k = 0; k < 120; k++) {
  water.step(1 / 60); field.flushColumns();
}
for (let c = 0; c < WATER_NX * WATER_NZ; c++) if (!Number.isFinite(water.hc[c]) || water.hc[c] < 0) { finite = false; break; }
check('deux secondes de houle avec un mur dans l eau : rien d absurde', finite && water.stats.wetCells > 800, `${water.stats.wetCells} cellules`);
const src = buildWaterShaders();
check('les shaders GPU portent la taille non carree', src.flux.includes('#define WN 208') && src.flux.includes('#define WM 112') && src.fine.includes('#define NX 416'));

if (failures) {
  console.log(`\n${failures} test(s) de taille de carte en echec.`);
  process.exit(1);
}
console.log('\nTous les tests de taille de carte passent.');
