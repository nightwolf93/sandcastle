/**
 * Construit un chateau de sable complet par script, puis le photographie.
 *
 * C'est l'epreuve de verite : est-ce que les operations de brosse produisent
 * vraiment des tours, des murs, des creneaux et une douve credibles ? Un test
 * numerique peut passer alors que le resultat est illisible a l'ecran.
 *
 *   node tools/build-castle.mjs [nom]
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });
const name = process.argv[2] || 'castle';

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
await page.setViewport({ width: 1600, height: 1000 });
const logs = [];
page.on('pageerror', (e) => logs.push('[err] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') logs.push('[console] ' + m.text()); });

console.log('Chargement...');
await page.goto(process.env.SC_URL || 'http://localhost:5173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
await page.evaluate(() => {
  // Rendu logiciel : l'auto-qualite retrograderait. On force le palier haut.
  window.game._qualityProbe = -1;
  window.game.setQuality(2, false);
});
console.log('Charge. Construction...');

// ---------------------------------------------------------------------------
// Le chantier, execute dans la page.
// ---------------------------------------------------------------------------
const report = await page.evaluate(async () => {
  const g = window.game;
  const B = g.tools.brush;
  const ctx = g.tools.ctx;
  const F = g.field;

  // Le chantier est fait en une seule passe de geometrie, puis on laisse la
  // physique tourner : si la construction est mal proportionnee, elle
  // s'effondrera d'elle-meme. C'est justement ce qu'on veut verifier.
  g.tools.undo.beginGroup('chantier');

  // Centre du chateau : en haut de plage, sur du sable sec (donc a mouiller).
  const CX = -1.6, CZ = -1.6;
  const ground = F.surfaceHeightAt(CX, CZ);

  const W = 0.14;   // humidite visee : le "sable parfait"
  const P = 0.92;   // compaction : pound-up

  // --- 0. on mouille l'emprise, sans noyer ---------------------------------
  // Les spheres se recouvrent : une dose trop forte sature le sable et tout
  // s'affaisse. On vise la fenetre utile, autour de 12 a 15 %.
  for (let dz = -2.6; dz <= 2.6; dz += 0.22) {
    for (let dx = -2.6; dx <= 2.6; dx += 0.22) {
      if (dx * dx + dz * dz > 7.6) continue;
      g.moisture.wetSphere(CX + dx, ground - 0.1, CZ + dz, 0.3, 0.02);
    }
  }

  const towers = [
    { x: -1.5, z: -1.5, r: 0.30, h: 1.00 },
    { x: 1.5, z: -1.5, r: 0.30, h: 1.00 },
    { x: -1.5, z: 1.5, r: 0.30, h: 1.00 },
    { x: 1.5, z: 1.5, r: 0.30, h: 1.00 },
    { x: 0.0, z: 0.0, r: 0.46, h: 1.55 }, // donjon
  ];

  // --- 1. plateforme -------------------------------------------------------
  // Une base large : sans elle, aucune tour ne tient (H_max varie en R^(2/3)).
  for (let dz = -2.2; dz <= 2.2; dz += 0.16) {
    for (let dx = -2.2; dx <= 2.2; dx += 0.16) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) > 2.05) continue;
      B.sphere(ctx, CX + dx, ground + 0.10, CZ + dz, 0.26, 255,
        { moisture: W, packing: P, hardness: 0.7 });
    }
  }
  // On arase le dessus a la truelle.
  for (let dz = -2.1; dz <= 2.1; dz += 0.3) {
    for (let dx = -2.1; dx <= 2.1; dx += 0.3) {
      B.planeCut(ctx, CX + dx, ground + 0.22, CZ + dz, 0, 1, 0, 0.34, 0.5, 1);
    }
  }
  const deck = ground + 0.22;

  // --- 2. tours ------------------------------------------------------------
  for (const t of towers) {
    B.stampBucket(ctx, CX + t.x, deck - 0.05, CZ + t.z,
      t.r, t.r * 0.82, t.h, W, P, 0.95);
  }

  // --- 3. courtines entre les tours ---------------------------------------
  const wallH = 0.62, wallT = 0.15;
  const corners = towers.slice(0, 4).map((t) => [t.x, t.z]);
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0]];
  for (const [a, b] of edges) {
    const [ax, az] = corners[a], [bx, bz] = corners[b];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / 0.05);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = CX + ax + (bx - ax) * t;
      const z = CZ + az + (bz - az) * t;
      for (let hy = 0; hy <= wallH; hy += 0.05) {
        B.sphere(ctx, x, deck + hy, z, wallT, 255,
          { moisture: W, packing: P, hardness: 0.85 });
      }
    }
  }

  // --- 4. faces planes des murs (truelle) ---------------------------------
  for (const [a, b] of edges) {
    const [ax, az] = corners[a], [bx, bz] = corners[b];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const nx = dz / len, nz = -dx / len; // normale au mur
    const steps = Math.ceil(len / 0.14);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = CX + ax + dx * t, z = CZ + az + dz * t;
      for (let hy = 0.06; hy <= wallH; hy += 0.16) {
        B.planeCut(ctx, x + nx * wallT * 0.9, deck + hy, z + nz * wallT * 0.9,
          nx, 0, nz, 0.22, 0.35, 1);
        B.planeCut(ctx, x - nx * wallT * 0.9, deck + hy, z - nz * wallT * 0.9,
          -nx, 0, -nz, 0.22, 0.35, 1);
      }
    }
  }

  // --- 5. creneaux ---------------------------------------------------------
  // Un merlon sur deux : on creuse les embrasures a la mirette.
  for (const [a, b] of edges) {
    const [ax, az] = corners[a], [bx, bz] = corners[b];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.floor(len / 0.16);
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) continue;
      const t = (i + 0.5) / n;
      const x = CX + ax + (bx - ax) * t;
      const z = CZ + az + (bz - az) * t;
      B.sphere(ctx, x, deck + wallH + 0.02, z, 0.062, -255, { hardness: 0.95 });
    }
  }
  // Creneaux des tours
  for (const t of towers) {
    const n = Math.max(6, Math.round((2 * Math.PI * t.r * 0.82) / 0.13));
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) continue;
      const a = (i / n) * Math.PI * 2;
      B.sphere(ctx,
        CX + t.x + Math.cos(a) * t.r * 0.82,
        deck - 0.05 + t.h + 0.01,
        CZ + t.z + Math.sin(a) * t.r * 0.82,
        0.055, -255, { hardness: 0.95 });
    }
  }

  // --- 6. porte en arc -----------------------------------------------------
  const gate = { x: 0, z: -1.5 };
  for (let hy = 0; hy <= 0.30; hy += 0.03) {
    const half = hy < 0.18 ? 0.11 : 0.11 * Math.sqrt(Math.max(0, 1 - ((hy - 0.18) / 0.12) ** 2));
    for (let s = -half; s <= half; s += 0.035) {
      B.sphere(ctx, CX + gate.x + s, deck + hy + 0.03, CZ + gate.z, 0.085, -255,
        { hardness: 0.9 });
    }
  }

  // --- 7. texture d'appareil sur les murs ----------------------------------
  for (const [a, b] of edges) {
    const [ax, az] = corners[a], [bx, bz] = corners[b];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const nx = dz / len, nz = -dx / len;
    const steps = Math.ceil(len / 0.3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = CX + ax + dx * t, z = CZ + az + dz * t;
      B.rake(ctx, x + nx * wallT, deck + wallH * 0.5, z + nz * wallT,
        nx, 0, nz, 0.2, 0.055, 0.016);
    }
  }

  // --- 8. douve ------------------------------------------------------------
  const moatR = 2.75, moatW = 0.42;
  for (let a = 0; a < Math.PI * 2; a += 0.02) {
    for (let rr = -moatW; rr <= moatW; rr += 0.09) {
      const x = CX + Math.cos(a) * (moatR + rr);
      const z = CZ + Math.sin(a) * (moatR + rr);
      const depth = 0.30 * (1 - (rr / moatW) ** 2);
      const top = F.surfaceHeightAt(x, z);
      for (let d = 0; d < depth; d += 0.05) {
        B.sphere(ctx, x, top - d, z, 0.15, -255, { hardness: 0.5 });
      }
    }
  }

  g.tools.undo.endGroup();
  F.flushColumns();

  // --- 9. de l'eau dans la douve ------------------------------------------
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    g.water.pour(CX + Math.cos(a) * moatR, CZ + Math.sin(a) * moatR, 0.22, 0.0045);
  }

  // --- 10. drapeaux au sommet des tours -----------------------------------
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    g.props.place(i % 2, CX + t.x, deck - 0.05 + t.h + 0.02, CZ + t.z, { x: 0, y: 1, z: 0 });
  }
  // Quelques coquillages sur la plateforme
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 1.1;
    g.props.place(2 + (Math.random() < 0.3 ? 1 : 0),
      CX + Math.cos(a) * r, deck, CZ + Math.sin(a) * r, { x: 0, y: 1, z: 0 });
  }

  // --- cadrage ------------------------------------------------------------
  g.controls.goalTarget.set(CX, deck + 0.5, CZ);
  g.controls.target.set(CX, deck + 0.5, CZ);
  g.controls.goalDistance = 6.6;
  g.controls.distance = 6.6;
  g.controls.goalAzimuth = Math.PI * 0.72;
  g.controls.azimuth = Math.PI * 0.72;
  g.controls.goalPolar = 0.92;
  g.controls.polar = 0.92;
  g.dayT = 0.33;
  g.sky.update(g.dayT, true);

  return {
    deck,
    ground,
    towers: towers.length,
    active: g.granular.stats.active,
  };
});

console.log('Chantier pose :', JSON.stringify(report));
console.log('On laisse la physique se stabiliser...');
await new Promise((r) => setTimeout(r, 9000));

const after = await page.evaluate(() => {
  const g = window.game;
  const F = g.field;
  const CX = -1.6, CZ = -1.6;
  const probe = (x, z) => +F.surfaceHeightAt(CX + x, CZ + z).toFixed(3);
  return {
    donjon: probe(0, 0),
    tourNO: probe(-1.5, -1.5),
    murN: probe(0, -1.5),
    douve: probe(2.75, 0),
    eauDouve: +g.water.depthAt(CX + 2.75, CZ).toFixed(3),
    active: g.granular.stats.active,
    tris: Math.round(g.stats.triangles),
    queue: g.stats.meshQueue,
    fps: +g.stats.fps.toFixed(0),
  };
});
console.log('Apres stabilisation :', JSON.stringify(after, null, 1));

// Une premiere image AVEC l'interface : c'est ce que voit le joueur.
await page.evaluate(() => {
  const g = window.game;
  g.controls.goalDistance = 8.2; g.controls.distance = 8.2;
  g.controls.goalPolar = 0.82; g.controls.polar = 0.82;
  g.tools.select('trowel');
});
await new Promise((r) => setTimeout(r, 1600));
writeFileSync(join(OUT, name + '-jeu.png'), await page.screenshot({ type: 'png' }));
console.log('capture :', join(OUT, name + '-jeu.png'));

// Puis le mode photo, sans interface.
await page.evaluate(() => {
  const g = window.game;
  g.controls.goalDistance = 6.6; g.controls.distance = 6.6;
  g.controls.goalPolar = 0.92; g.controls.polar = 0.92;
  g.togglePhotoMode();
});
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => { window.game.controls.autoRotate = false; });
await new Promise((r) => setTimeout(r, 800));

const buf = await page.screenshot({ type: 'png' });
writeFileSync(join(OUT, name + '.png'), buf);
console.log('capture :', join(OUT, name + '.png'));

// Variante sans etalonnage, pour comparer et diagnostiquer le post-traitement.
await page.evaluate(() => { window.game.post.grade.enabled = false; });
await new Promise((r) => setTimeout(r, 900));
writeFileSync(join(OUT, name + '-brut.png'), await page.screenshot({ type: 'png' }));
console.log('capture :', join(OUT, name + '-brut.png'));
if (logs.length) console.log('logs :\n' + logs.slice(0, 12).join('\n'));

await browser.close();
