/**
 * Test d'integration : on joue vraiment.
 *
 * Puppeteer pilote la souris et le clavier comme un joueur, et on verifie
 * dans la page que le terrain a bouge comme il faut. C'est le seul test qui
 * couvre la chaine complete : entree -> lancer de rayon -> brosse -> physique
 * -> maillage -> rendu.
 *
 *   node tools/test-play.mjs [--keep]
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

const url = process.env.SC_URL || 'http://localhost:5173/?fresh=1';
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
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('Chargement...');
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
console.log('Charge.\n');

const W = 1280, H = 800;
const CX = Math.round(W * 0.52), CY = Math.round(H * 0.52);

/** Hauteur du terrain sous un point ecran, via un lancer de rayon dans la page. */
async function heightAtScreen(x, y) {
  return page.evaluate(({ x, y, W, H }) => {
    const g = window.game;
    const THREE = g.tools.raycaster.constructor;
    g.tools.pointer.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
    g.tools.hasPointer = true;
    g.tools.raycaster.setFromCamera(g.tools.pointer, g.camera);
    const o = g.tools.raycaster.ray.origin, d = g.tools.raycaster.ray.direction;
    const hit = g.field.raycast({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, 60);
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
  }, { x, y, W, H });
}

async function probe(wx, wz) {
  return page.evaluate(({ wx, wz }) => {
    const g = window.game;
    return {
      surface: g.field.surfaceHeightAt(wx, wz),
      water: g.water.depthAt(wx, wz),
      moisture: g.field.averageMoisture(wx, g.field.surfaceHeightAt(wx, wz) - 0.05, wz, 0.1),
      packing: g.field.averagePacking(wx, g.field.surfaceHeightAt(wx, wz) - 0.05, wz, 0.1),
    };
  }, { wx, wz });
}

/** Profondeur d eau maximale dans un rayon donne (m). */
async function maxWater(wx, wz, radius) {
  return page.evaluate(({ wx, wz, radius }) => {
    const g = window.game;
    let best = 0;
    const step = radius / 8;
    for (let dz = -radius; dz <= radius; dz += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const d = g.water.depthAt(wx + dx, wz + dz);
        if (d > best) best = d;
      }
    }
    return best;
  }, { wx, wz, radius });
}

async function settle(ms = 900) {
  await new Promise((r) => setTimeout(r, ms));
}

async function selectTool(id) {
  await page.evaluate((i) => window.game.tools.select(i), id);
}
async function setRadius(r) {
  await page.evaluate((v) => window.game.tools.setRadius(v), r);
}

async function stroke(points, ms = 420, button = 'left') {
  await page.mouse.move(points[0][0], points[0][1]);
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.down({ button });
  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, ms / points.length));
  }
  await page.mouse.up({ button });
  await new Promise((r) => setTimeout(r, 120));
}

// ---------------------------------------------------------------------------
console.log('== La pelle creuse et ramasse du sable ==');
const target = await heightAtScreen(CX, CY);
check('le lancer de rayon touche le sable', !!target,
  target ? `(${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)})` : 'aucun');

if (target) {
  const before = await probe(target.x, target.z);
  await selectTool('shovel');
  await setRadius(0.22);
  await stroke([[CX, CY], [CX + 6, CY + 4], [CX - 5, CY - 3], [CX, CY]], 700);
  await settle(1400);
  const after = await probe(target.x, target.z);
  const carried = await page.evaluate(() => window.game.carried.volume);

  console.log(`  surface ${before.surface.toFixed(3)} -> ${after.surface.toFixed(3)} m`);
  check('un trou est creuse', before.surface - after.surface > 0.05,
    `${((before.surface - after.surface) * 100).toFixed(1)} cm`);
  check('la pelle contient du sable', carried > 0.001, `${(carried * 1000).toFixed(1)} L`);
  check('le sable du fond est plus humide', after.moisture > before.moisture - 0.001,
    `${(before.moisture * 100).toFixed(1)} % -> ${(after.moisture * 100).toFixed(1)} %`);

  // --- annulation ---------------------------------------------------------
  console.log('\n== Annulation ==');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  await settle(700);
  const undone = await probe(target.x, target.z);
  check('Ctrl+Z rebouche le trou', Math.abs(undone.surface - before.surface) < 0.03,
    `${undone.surface.toFixed(3)} m (attendu ${before.surface.toFixed(3)})`);

  // --- arrosoir -----------------------------------------------------------
  console.log('\n== Arrosoir ==');
  const dry = await probe(target.x, target.z);
  await selectTool('can');
  await setRadius(0.3);
  await stroke([[CX, CY], [CX, CY]], 900);
  await settle(600);
  const wet = await probe(target.x, target.z);
  check('l arrosoir humidifie le sable', wet.moisture > dry.moisture + 0.01,
    `${(dry.moisture * 100).toFixed(1)} % -> ${(wet.moisture * 100).toFixed(1)} %`);

  // --- main : tassement ---------------------------------------------------
  console.log('\n== Tassement a la main ==');
  const loose = await probe(target.x, target.z);
  await selectTool('hand');
  await setRadius(0.25);
  await stroke([[CX, CY], [CX + 3, CY], [CX, CY]], 900);
  await settle(500);
  const packed = await probe(target.x, target.z);
  check('la main tasse le sable', packed.packing > loose.packing + 0.02,
    `${(loose.packing * 100).toFixed(0)} % -> ${(packed.packing * 100).toFixed(0)} %`);

  // --- seau ---------------------------------------------------------------
  console.log('\n== Seau : remplir puis demouler ==');
  await selectTool('bucket');
  await setRadius(0.16);
  const dropX = CX + 150, dropY = CY - 40;
  const dropTarget = await heightAtScreen(dropX, dropY);
  const beforeTower = dropTarget ? await probe(dropTarget.x, dropTarget.z) : null;
  // On remplit sur place, puis on va demouler plus loin.
  await page.mouse.move(CX, CY);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 900));
  const fill = await page.evaluate(() => window.game.tools.current.fill);
  await page.mouse.move(dropX, dropY, { steps: 12 });
  await new Promise((r) => setTimeout(r, 250));
  await page.mouse.up();
  // Le demoulage n'est plus instantane : c'est une sequence en sept temps
  // (lever, retourner, poser, tapoter, drainer, decouvrir). On attend qu'elle
  // soit finie au lieu de deviner une duree — en rendu logiciel elle prend
  // plusieurs secondes de plus qu'en jeu.
  await page.waitForFunction(
    () => !window.game?.toolAvatar?.bucket?.busy, { timeout: 60000 }
  ).catch(() => {});
  await settle(1200);
  check('le seau se remplit', fill > 0.15, `${(fill * 100).toFixed(0)} %`);
  const dem = await page.evaluate(() => window.game.lastDemould);
  if (dem) console.log(`  demoulage : ${dem.outcome} (q ${dem.f ?? dem.q.toFixed(2)}, w ${(dem.moisture * 100).toFixed(1)} %, h ${(dem.height * 100).toFixed(0)} cm)`);
  if (dropTarget) {
    const afterTower = await probe(dropTarget.x, dropTarget.z);
    check('une tour est demoulee', afterTower.surface - beforeTower.surface > 0.04,
      `+${((afterTower.surface - beforeTower.surface) * 100).toFixed(1)} cm`);
  }

  // --- eau ----------------------------------------------------------------
  console.log('\n== Seau d eau : la flaque ==');
  await selectTool('water');
  await setRadius(0.3);
  const poolX = CX - 130, poolY = CY + 60;
  const poolTarget = await heightAtScreen(poolX, poolY);
  // On creuse d abord un creux, sinon l eau s ecoule.
  await selectTool('shovel');
  await setRadius(0.3);
  await stroke([[poolX, poolY], [poolX, poolY]], 900);
  await settle(800);
  await selectTool('water');
  // Le creusement a deplace le point vise : on repointe.
  const poolTarget2 = await heightAtScreen(poolX, poolY);
  await stroke([[poolX, poolY], [poolX, poolY]], 900);
  await settle(900);
  const pt = poolTarget2 || poolTarget;
  if (pt) {
    const depth = await maxWater(pt.x, pt.z, 0.4);
    check('de l eau reste dans le creux', depth > 0.004,
      `${(depth * 100).toFixed(1)} cm`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== Sauvegarde et rechargement ==');
{
  // La physique continue de tourner : on la met en pause, sinon la comparaison
  // mesure l'erosion et pas la fidelite de la sauvegarde.
  await page.evaluate(() => { window.game.paused = true; });
  await settle(400);
  const before = await page.evaluate(() => {
    const g = window.game;
    let sum = 0;
    for (let i = 0; i < g.field.density.length; i += 97) sum += g.field.density[i];
    return { sum, props: g.props.count, dayT: g.dayT };
  });
  const saved = await page.evaluate(async () => {
    const t = performance.now();
    const r = await window.game.save.save('test');
    return { kb: r.kb, ms: performance.now() - t };
  });
  console.log(`  ${saved.kb.toFixed(0)} Ko compresses en ${saved.ms.toFixed(0)} ms`);
  check('la sauvegarde tient dans un format raisonnable', saved.kb < 1600,
    `${saved.kb.toFixed(0)} Ko`);

  // On saccage le terrain, puis on recharge.
  await page.evaluate(() => {
    const g = window.game;
    const B = g.tools.brush;
    for (let i = 0; i < 40; i++) {
      B.sphere(g.tools.ctx, -2 + i * 0.1, 1.6, 0, 0.4, -255, { hardness: 0.4 });
    }
    g.field.flushColumns();
  });
  const wrecked = await page.evaluate(() => {
    let sum = 0;
    const d = window.game.field.density;
    for (let i = 0; i < d.length; i += 97) sum += d[i];
    return sum;
  });
  check('le terrain a bien ete modifie avant rechargement', wrecked !== before.sum,
    `${before.sum} -> ${wrecked}`);

  await page.evaluate(() => window.game.save.load('test'));
  await settle(1200);
  // L'echantillon se prend AVANT de relancer la physique : le chargement
  // reveille le granulaire sur tout le domaine, et une seule frame de
  // simulation suffit a deplacer quelques voxels — on mesurerait alors la
  // physique, pas la fidelite de la sauvegarde.
  const after = await page.evaluate(() => {
    const g = window.game;
    let sum = 0;
    for (let i = 0; i < g.field.density.length; i += 97) sum += g.field.density[i];
    return { sum, props: g.props.count, dayT: g.dayT };
  });
  await page.evaluate(() => { window.game.paused = false; });
  check('le rechargement restitue le terrain a l identique', after.sum === before.sum,
    `${before.sum} vs ${after.sum}`);
  check('le rechargement restitue le decor', after.props === before.props,
    `${before.props} vs ${after.props}`);
  await page.evaluate(() => window.game.save.remove('test'));
}

// ---------------------------------------------------------------------------
console.log('\n== Sante generale ==');
const stats = await page.evaluate(() => {
  const g = window.game;
  return {
    fps: g.stats.fps, sim: g.stats.sim, tris: g.stats.triangles,
    queue: g.stats.meshQueue, active: g.stats.activeVoxels,
    undoMB: g.tools.undo.bytes / 1048576,
    props: g.props.count,
    glError: g.renderer.getContext().getError(),
  };
});
console.log('  ' + JSON.stringify(stats, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
check('aucune erreur WebGL', stats.glError === 0, 'code ' + stats.glError);
check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
check('la file de maillage se resorbe', stats.queue < 60, `${stats.queue} chunks`);
check('memoire d annulation raisonnable', stats.undoMB < 80, `${stats.undoMB.toFixed(1)} Mo`);

const buf = await page.screenshot({ type: 'png' });
writeFileSync(join(OUT, 'play.png'), buf);
console.log('\n  capture : shots/play.png');

if (errors.length) {
  console.log('\n  Erreurs :');
  for (const e of errors.slice(0, 10)) console.log('   - ' + e);
}

await browser.close();
console.log(failures === 0 ? '\nTous les tests de jeu passent.\n' : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
