/**
 * La marée reprend le château.
 *
 * Bâtit une petite forteresse au milieu de la face de plage, sauvegarde, puis
 * accélère la marée jusqu'à la pleine mer et photographie les trois moments.
 * Vérifie au passage que la reprise de partie fonctionne — c'est le seul
 * chemin de code que les autres tests évitent (ils forcent `?fresh=1`).
 *
 *   node tools/test-tide.mjs
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

console.log('Chargement (plage vierge)...');
await page.goto('http://localhost:5173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
await page.evaluate(() => {
  window.game._qualityProbe = -1;
  window.game.setQuality(2, false);
});

// ---------------------------------------------------------------------------
console.log('\n== Construction sur la face de plage ==');
const site = await page.evaluate(() => {
  const g = window.game;
  const B = g.tools.brush;
  const ctx = g.tools.ctx;
  const F = g.field;

  // On cherche un point dont le terrain est vers 1.30 m : en plein dans la
  // zone que la pleine mer viendra chercher.
  let best = null, bestErr = 9;
  for (let z = -4.5; z <= 4.5; z += 0.3) {
    for (let x = -4.5; x <= 4.5; x += 0.3) {
      const h = F.surfaceHeightAt(x, z);
      const err = Math.abs(h - 1.3);
      if (err < bestErr) { bestErr = err; best = { x, z, h }; }
    }
  }
  const { x: CX, z: CZ } = best;
  const ground = F.surfaceHeightAt(CX, CZ);
  const W = 0.14, P = 0.9;

  g.tools.undo.beginGroup('fort');
  // Plateforme
  for (let dz = -1.1; dz <= 1.1; dz += 0.14) {
    for (let dx = -1.1; dx <= 1.1; dx += 0.14) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) > 1.05) continue;
      B.sphere(ctx, CX + dx, ground + 0.1, CZ + dz, 0.22, 255,
        { moisture: W, packing: P, hardness: 0.7 });
    }
  }
  const deck = ground + 0.2;
  // Quatre tours et un donjon
  const towers = [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]];
  for (const [tx, tz] of towers) {
    B.stampBucket(ctx, CX + tx, deck - 0.04, CZ + tz, 0.2, 0.17, 0.55, W, P, 0.95);
  }
  B.stampBucket(ctx, CX, deck - 0.04, CZ, 0.3, 0.26, 0.85, W, P, 0.95);
  // Courtines
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0]];
  for (const [a, b] of edges) {
    const [ax, az] = towers[a], [bx, bz] = towers[b];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.05);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      for (let hy = 0; hy <= 0.34; hy += 0.05) {
        B.sphere(ctx, CX + ax + (bx - ax) * t, deck + hy, CZ + az + (bz - az) * t,
          0.11, 255, { moisture: W, packing: P, hardness: 0.85 });
      }
    }
  }
  g.tools.undo.endGroup();
  F.flushColumns();
  for (let i = 0; i < 4; i++) g.props.place(i % 2, CX + towers[i][0], deck + 0.5, CZ + towers[i][1], null);

  g.controls.goalTarget.set(CX, deck + 0.35, CZ);
  g.controls.target.copy(g.controls.goalTarget);
  g.controls.goalDistance = g.controls.distance = 4.6;
  g.controls.goalAzimuth = g.controls.azimuth = Math.PI * 0.7;
  g.controls.goalPolar = g.controls.polar = 1.15;
  g.water.tideSpeed = 0;
  g.water.time = 0;
  return { CX, CZ, ground, deck };
});
console.log('  site : ' + JSON.stringify(site, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v));

await new Promise((r) => setTimeout(r, 6000));
await page.evaluate(() => window.game.togglePhotoMode());
await new Promise((r) => setTimeout(r, 2200));
await page.evaluate(() => { window.game.controls.autoRotate = false; });
await new Promise((r) => setTimeout(r, 600));
writeFileSync(join(OUT, 'tide-1-basse.png'), await page.screenshot({ type: 'png' }));
console.log('  capture : shots/tide-1-basse.png');

const before = await page.evaluate((s) => {
  const g = window.game;
  return {
    top: g.field.surfaceHeightAt(s.CX, s.CZ),
    water: g.water.depthAt(s.CX, s.CZ),
    sea: g.water.seaLevel,
  };
}, site);
console.log(`  sommet du donjon : ${before.top.toFixed(2)} m, mer a ${before.sea.toFixed(2)} m`);

// ---------------------------------------------------------------------------
console.log('\n== On sauvegarde, puis la maree monte ==');
await page.evaluate(() => window.game.save.save('auto'));

await page.evaluate(() => {
  const g = window.game;
  // On saute directement a mi-montee, puis on laisse filer vite.
  g.water.time = 150;
  g.water.tideSpeed = 26;
});
await new Promise((r) => setTimeout(r, 9000));
writeFileSync(join(OUT, 'tide-2-montante.png'), await page.screenshot({ type: 'png' }));
console.log('  capture : shots/tide-2-montante.png');

await new Promise((r) => setTimeout(r, 14000));
const after = await page.evaluate((s) => {
  const g = window.game;
  // On mesure l'eau AUTOUR du fort : son centre est une plateforme surelevee,
  // il serait absurde d'y chercher de l'eau.
  let ring = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.15) {
    const d = g.water.depthAt(s.CX + Math.cos(a) * 1.6, s.CZ + Math.sin(a) * 1.6);
    if (d > ring) ring = d;
  }
  return {
    top: g.field.surfaceHeightAt(s.CX, s.CZ),
    water: ring,
    sea: g.water.seaLevel,
    tide: g.water.tidePhase,
  };
}, site);
writeFileSync(join(OUT, 'tide-3-haute.png'), await page.screenshot({ type: 'png' }));
console.log('  capture : shots/tide-3-haute.png');
console.log(`  mer a ${after.sea.toFixed(2)} m (phase ${(after.tide * 100).toFixed(0)} %), ` +
  `eau sur le site : ${(after.water * 100).toFixed(1)} cm, ` +
  `sommet ${before.top.toFixed(2)} -> ${after.top.toFixed(2)} m`);

check('la maree monte reellement jusqu au site', after.sea > before.sea + 0.2,
  `${before.sea.toFixed(2)} -> ${after.sea.toFixed(2)} m`);
check('la mer atteint le pied du fort', after.water > 0.02,
  `${(after.water * 100).toFixed(1)} cm d eau autour`);

// ---------------------------------------------------------------------------
console.log('\n== Reprise de la partie sauvegardee ==');
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const resumed = await page.evaluate((s) => {
  const g = window.game;
  return { top: g.field.surfaceHeightAt(s.CX, s.CZ), props: g.props.count };
}, site);
console.log(`  sommet retrouve : ${resumed.top.toFixed(2)} m (sauvegarde a ${before.top.toFixed(2)} m)`);
check('la partie sauvegardee est bien rechargee au demarrage',
  Math.abs(resumed.top - before.top) < 0.08,
  `${resumed.top.toFixed(2)} vs ${before.top.toFixed(2)}`);

check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nTous les tests de maree passent.\n' : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
