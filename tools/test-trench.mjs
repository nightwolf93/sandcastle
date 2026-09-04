/**
 * Creuser des tranchées et y faire couler l'eau.
 *
 * Trois choses sont vérifiées, dans cet ordre :
 *
 *   1. UNE FOSSE AU-DESSUS DE LA NAPPE RESTE SÈCHE. C'est le garde-fou :
 *      si de l'eau apparaissait toute seule, tout le reste du test ne
 *      prouverait rien.
 *
 *   2. UN CANAL DEPUIS LA MER NE REMPLIT PAS UNE FOSSE PLUS HAUTE QUE LA MER.
 *      L'eau ne remonte pas les pentes. C'est évident, et c'est exactement
 *      pour ça qu'il faut le tester : c'est le genre de chose qu'un solveur
 *      mal bridé fait volontiers.
 *
 *   3. UNE TRANCHÉE CONDUIT VRAIMENT L'EAU. On verse un seau en haut d'une
 *      tranchée, l'eau doit descendre le long du tracé et s'accumuler dans la
 *      fosse au bout — sans déborder ailleurs.
 *
 *   node tools/test-trench.mjs
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await puppeteer.launch({
  headless: 'shell',
  // Le rendu logiciel met parfois plusieurs dizaines de secondes a compiler
  // les shaders : le delai par defaut de 30 s ne suffit pas.
  protocolTimeout: 240000,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('Chargement...');
await page.goto('http://localhost:5173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
await page.evaluate(() => {
  window.game._qualityProbe = -1;
  window.game.setQuality(2, false);
  // Marée figée : on isole l'effet du creusement, pas celui du flot.
  window.game.water.tideSpeed = 0;
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fait avancer la simulation d'un nombre exact de pas, sans dependre du
 * framerate. Le rendu logiciel de Puppeteer tourne a une dizaine d'images par
 * seconde : mesurer en secondes d'horloge donnerait des resultats qui varient
 * du simple au sextuple selon la machine.
 */
async function simulate(steps) {
  const CHUNK = 240;
  for (let done = 0; done < steps; done += CHUNK) {
    await page.evaluate((n) => {
      const g = window.game;
      for (let i = 0; i < n; i++) g.step(1 / 60);
      g.field.flushColumns();
    }, Math.min(CHUNK, steps - done));
    await settle(120); // laisse le mailleur et le rendu respirer
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 1. Une fosse haut sur la plage ==');
const plan = await page.evaluate(() => {
  const g = window.game;
  const F = g.field;
  const V = 0.04;
  const NXX = Math.round(Math.sqrt(g.water.shore.length));
  const O = -NXX * V * 0.5;
  const R = -O - 0.5;
  const shoreAt = (x, z) =>
    g.water.shore[Math.round((x - O) / V) + NXX * Math.round((z - O) / V)];

  let seaPt = null, landPt = null, bestSea = 9, bestLand = 9;
  for (let z = -R; z <= R; z += 0.16) {
    for (let x = -R; x <= R; x += 0.16) {
      const s = shoreAt(x, z);
      if (s === undefined) continue;
      const dSea = Math.abs(s + 2.4);
      if (dSea < bestSea) { bestSea = dSea; seaPt = { x, z, shore: s }; }
      const h = F.surfaceHeightAt(x, z);
      const dLand = Math.abs(h - 1.66);
      if (dLand < bestLand && s > 4.4) { bestLand = dLand; landPt = { x, z, h, shore: s }; }
    }
  }
  // Point de départ de la tranchée : plus haut que la fosse, vers l'intérieur.
  let upPt = null, bestUp = -9;
  for (let a = 0; a < Math.PI * 2; a += 0.15) {
    const x = landPt.x + Math.cos(a) * 1.9;
    const z = landPt.z + Math.sin(a) * 1.9;
    if (Math.abs(x) > R + 0.2 || Math.abs(z) > R + 0.2) continue;
    const h = F.surfaceHeightAt(x, z);
    if (h > bestUp) { bestUp = h; upPt = { x, z, h }; }
  }
  return { seaPt, landPt, upPt, table: g.water.waterTable, sea: g.water.seaLevel };
});
console.log(`  fosse : (${plan.landPt.x.toFixed(2)}, ${plan.landPt.z.toFixed(2)}) ` +
  `terrain ${plan.landPt.h.toFixed(2)} m`);
console.log(`  amont : (${plan.upPt.x.toFixed(2)}, ${plan.upPt.z.toFixed(2)}) ` +
  `terrain ${plan.upPt.h.toFixed(2)} m`);
console.log(`  mer a ${plan.sea.toFixed(2)} m, nappe a ${plan.table.toFixed(2)} m`);

const pit = await page.evaluate((p) => {
  const g = window.game;
  const B = g.tools.brush;
  for (let d = 0; d < 0.34; d += 0.05) {
    for (let dz = -0.55; dz <= 0.55; dz += 0.1) {
      for (let dx = -0.55; dx <= 0.55; dx += 0.1) {
        if (dx * dx + dz * dz > 0.31) continue;
        B.sphere(g.tools.ctx, p.landPt.x + dx, p.landPt.h - d, p.landPt.z + dz,
          0.18, -255, { hardness: 0.4 });
      }
    }
  }
  g.field.flushColumns();
  return { floor: g.field.surfaceHeightAt(p.landPt.x, p.landPt.z) };
}, plan);
await simulate(180);
const dry = await page.evaluate((p) => window.game.water.depthAt(p.landPt.x, p.landPt.z), plan);
console.log(`  fond a ${pit.floor.toFixed(2)} m, eau : ${(dry * 100).toFixed(1)} cm`);
check('le fond de fosse est au-dessus de la nappe', pit.floor > plan.table + 0.05,
  `${pit.floor.toFixed(2)} m > ${plan.table.toFixed(2)} m`);
check('la fosse reste seche : aucune eau ne se materialise', dry < 0.01,
  `${(dry * 100).toFixed(1)} cm`);

await page.evaluate((p) => {
  const g = window.game;
  g.togglePhotoMode();
  g.controls.goalTarget.set(p.landPt.x, p.landPt.h - 0.1, p.landPt.z);
  g.controls.target.copy(g.controls.goalTarget);
  g.controls.goalDistance = g.controls.distance = 4.4;
  g.controls.goalPolar = g.controls.polar = 1.0;
  g.controls.autoRotate = false;
}, plan);
await settle(2000);
writeFileSync(join(OUT, 'trench-1-fosse.png'), await page.screenshot({ type: 'png' }));
console.log('  capture : shots/trench-1-fosse.png');

// ---------------------------------------------------------------------------
console.log('\n== 2. Un canal vers la mer ne fait pas remonter l eau ==');
await page.evaluate((p) => {
  const g = window.game;
  const B = g.tools.brush;
  const F = g.field;
  const { x: ax, z: az } = p.landPt;
  const { x: bx, z: bz } = p.seaPt;
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(len / 0.06);
  const floorA = F.surfaceHeightAt(ax, az);
  const floorB = g.water.seaLevel - 0.12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const target = floorA + (floorB - floorA) * t;
    const top = F.surfaceHeightAt(x, z);
    for (let y = top; y > target; y -= 0.05) {
      B.sphere(g.tools.ctx, x, y, z, 0.15, -255, { hardness: 0.45 });
    }
  }
  F.flushColumns();
}, plan);
await simulate(900);
const uphill = await page.evaluate((p) => {
  const g = window.game;
  let pitD = 0, reach = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    for (const r of [0, 0.2]) {
      const d = g.water.depthAt(p.landPt.x + Math.cos(a) * r, p.landPt.z + Math.sin(a) * r);
      if (d > pitD) pitD = d;
    }
  }
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const x = p.seaPt.x + (p.landPt.x - p.seaPt.x) * t;
    const z = p.seaPt.z + (p.landPt.z - p.seaPt.z) * t;
    if (g.water.depthAt(x, z) > 0.01) reach = t;
  }
  return { pitD, reach };
}, plan);
console.log(`  l eau s arrete a ${(uphill.reach * 100).toFixed(0)} % du canal ` +
  `(la ou le fond repasse au-dessus du niveau de la mer)`);
check('l eau ne remonte pas la pente du canal', uphill.pitD < 0.01,
  `${(uphill.pitD * 100).toFixed(1)} cm dans la fosse`);
check('mais elle occupe bien la partie basse du canal', uphill.reach > 0.25,
  `${(uphill.reach * 100).toFixed(0)} % du trajet`);

// ---------------------------------------------------------------------------
console.log('\n== 3. Une tranchee amont conduit l eau versee ==');
await page.evaluate((p) => {
  const g = window.game;
  const B = g.tools.brush;
  const F = g.field;
  // Tranchee de l amont vers la fosse, avec une pente franche et reguliere.
  const { x: ax, z: az } = p.upPt;
  const { x: bx, z: bz } = p.landPt;
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(len / 0.05);
  const top0 = F.surfaceHeightAt(ax, az);
  const floorEnd = F.surfaceHeightAt(bx, bz) + 0.08;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const target = (top0 - 0.10) + (floorEnd - (top0 - 0.10)) * t;
    const top = F.surfaceHeightAt(x, z);
    for (let y = top; y > target; y -= 0.05) {
      B.sphere(g.tools.ctx, x, y, z, 0.11, -255, { hardness: 0.6 });
    }
  }
  F.flushColumns();
}, plan);
await simulate(150);

const before = await page.evaluate((p) => {
  const g = window.game;
  let d = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    for (const r of [0, 0.2, 0.35]) {
      const v = g.water.depthAt(p.landPt.x + Math.cos(a) * r, p.landPt.z + Math.sin(a) * r);
      if (v > d) d = v;
    }
  }
  return d;
}, plan);

// On verse en haut de la tranchee, comme le ferait le seau d eau.
await page.evaluate((p) => {
  const g = window.game;
  // Une vingtaine de litres : deux seaux de plage.
  for (let i = 0; i < 55; i++) {
    g.water.pour(p.upPt.x, p.upPt.z, 0.17, 0.00035);
  }
}, plan);

for (const t of [3, 8, 16]) {
  await simulate(t === 3 ? 180 : 300);
  const st = await page.evaluate((p) => {
    const g = window.game;
    let pitD = 0, reach = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      for (const r of [0, 0.2, 0.35]) {
        const v = g.water.depthAt(p.landPt.x + Math.cos(a) * r, p.landPt.z + Math.sin(a) * r);
        if (v > pitD) pitD = v;
      }
    }
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = p.upPt.x + (p.landPt.x - p.upPt.x) * t;
      const z = p.upPt.z + (p.landPt.z - p.upPt.z) * t;
      if (g.water.depthAt(x, z) > 0.006) reach = t;
    }
    return { pitD, reach };
  }, plan);
  console.log(`  t+${t}s (simule) : front a ${(st.reach * 100).toFixed(0)} % de la tranchee, ` +
    `${(st.pitD * 100).toFixed(1)} cm dans la fosse`);
}
await simulate(300);

const flowed = await page.evaluate((p) => {
  const g = window.game;
  let pitD = 0, reach = 0, outside = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    for (const r of [0, 0.2, 0.35]) {
      const v = g.water.depthAt(p.landPt.x + Math.cos(a) * r, p.landPt.z + Math.sin(a) * r);
      if (v > pitD) pitD = v;
    }
  }
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const x = p.upPt.x + (p.landPt.x - p.upPt.x) * t;
    const z = p.upPt.z + (p.landPt.z - p.upPt.z) * t;
    if (g.water.depthAt(x, z) > 0.006) reach = t;
  }
  // Debordement : de l eau loin du trace et de la fosse ?
  const dx = p.landPt.x - p.upPt.x, dz = p.landPt.z - p.upPt.z;
  const L = Math.hypot(dx, dz);
  const nx = -dz / L, nz = dx / L;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = p.upPt.x + dx * t, z = p.upPt.z + dz * t;
    for (const s of [-0.8, 0.8]) {
      if (g.water.depthAt(x + nx * s, z + nz * s) > 0.02) outside++;
    }
  }
  return { pitD, reach, outside };
}, plan);

check('l eau versee parcourt toute la tranchee', flowed.reach > 0.9,
  `${(flowed.reach * 100).toFixed(0)} % du trajet`);
check('elle s accumule au bout, dans la fosse', flowed.pitD > before + 0.015,
  `${(before * 100).toFixed(1)} -> ${(flowed.pitD * 100).toFixed(1)} cm`);
check('elle ne deborde pas hors de la tranchee', flowed.outside < 4,
  `${flowed.outside} points hors trace`);

writeFileSync(join(OUT, 'trench-2-ecoulement.png'), await page.screenshot({ type: 'png' }));
console.log('  capture : shots/trench-2-ecoulement.png');

check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nTous les tests de tranchee passent.\n' : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
