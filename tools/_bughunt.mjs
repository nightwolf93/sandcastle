/**
 * CHASSE AUX BUGS — session scriptée qui utilise chaque outil + cas limites,
 * et collecte TOUTES les erreurs/warnings console.
 */
import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const W = 1280, H = 800;
const browser = await puppeteer.launch({
  headless: 'shell',
  protocolTimeout: 240000,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });

const issues = [];
let phase = 'boot';
page.on('pageerror', (e) => issues.push(`[pageerror @${phase}] ${e.message}`));
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warn' || t === 'warning') {
    issues.push(`[console.${t} @${phase}] ${m.text()}`);
  }
});

console.log('Chargement...');
await page.goto('http://localhost:4173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.toolAvatar, { timeout: 30000 });
await page.evaluate(() => { window.game._qualityProbe = -1; window.game.setQuality(2, false); });
console.log('Charge.\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CX = Math.round(W * 0.52), CY = Math.round(H * 0.52);

async function stroke(points, ms = 400, button = 'left') {
  await page.mouse.move(points[0][0], points[0][1]);
  await wait(50);
  await page.mouse.down({ button });
  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    await wait(ms / points.length);
  }
  await page.mouse.up({ button });
  await wait(100);
}
const sel = (id) => page.evaluate((i) => window.game.tools.select(i), id);

// ---------------------------------------------------------------------------
phase = 'outils-souris';
console.log('== Tous les outils, a la souris ==');
for (const [id, btn] of [
  ['shovel', 'left'], ['shovel', 'right'], ['hand', 'left'], ['hand', 'right'],
  ['can', 'left'], ['can', 'right'], ['water', 'left'], ['water', 'right'],
  ['trowel', 'left'], ['trowel', 'right'], ['carve', 'left'], ['carve', 'right'],
  ['rake', 'left'], ['rake', 'right'], ['decor', 'left'], ['decor', 'right'],
  ['eraser', 'left'], ['eraser', 'right'],
]) {
  await sel(id);
  await stroke([[CX, CY], [CX + 8, CY + 4], [CX - 6, CY - 2]], 350, btn);
}
console.log('  ok');

// ---------------------------------------------------------------------------
phase = 'molette';
console.log('== Molette / Ctrl+molette / Maj+Ctrl+molette ==');
await sel('shovel');
await page.mouse.move(CX, CY);
await page.mouse.wheel({ deltaY: -240 });      // zoom
await wait(200);
await page.mouse.wheel({ deltaY: 240 });
await wait(200);
await page.keyboard.down('Control');
await page.mouse.wheel({ deltaY: -240 });      // rayon
await page.mouse.wheel({ deltaY: 240 });
await page.keyboard.up('Control');
await sel('rake');
await page.keyboard.down('Control'); await page.keyboard.down('Shift');
await page.mouse.wheel({ deltaY: -120 });      // ecartement rateau
await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await sel('decor');
await page.keyboard.down('Control'); await page.keyboard.down('Shift');
await page.mouse.wheel({ deltaY: 120 });       // variante decor
await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await wait(300);
console.log('  ok');

// ---------------------------------------------------------------------------
phase = 'seau-cycle';
console.log('== Seau : cycle complet ==');
await sel('bucket');
await page.evaluate(() => window.game.tools.setRadius(0.16));
// arroser d'abord pour un demoulage propre
await sel('can');
await stroke([[CX, CY], [CX, CY]], 900);
await sel('bucket');
await page.mouse.move(CX, CY);
await page.mouse.down();
await wait(1200);
await page.mouse.move(CX + 120, CY - 30, { steps: 10 });
await wait(200);
await page.mouse.up();
await page.waitForFunction(() => !window.game?.toolAvatar?.bucket?.busy, { timeout: 60000 }).catch(() => {});
await wait(500);
console.log('  demoulage:', await page.evaluate(() => window.game.lastDemould?.outcome));

// ---------------------------------------------------------------------------
phase = 'undo-pendant-seau';
console.log('== Undo PENDANT l animation du seau ==');
await page.mouse.move(CX, CY);
await page.mouse.down();
await wait(1000);
await page.mouse.up();
await wait(300);   // la sequence commence
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
await wait(200);
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
await page.waitForFunction(() => !window.game?.toolAvatar?.bucket?.busy, { timeout: 60000 }).catch(() => {});
await wait(500);
console.log('  ok');

// ---------------------------------------------------------------------------
phase = 'changement-outil-pendant-seau';
console.log('== Changement d outil PENDANT l animation du seau ==');
await sel('bucket');
await page.mouse.move(CX - 60, CY + 20);
await page.mouse.down();
await wait(1000);
await page.mouse.up();
await wait(400);   // la sequence est en cours
const busyBefore = await page.evaluate(() => window.game.toolAvatar.built.bucket?.bucket?.busy);
await sel('shovel');   // on change d'outil en plein retournement
await page.waitForFunction(() => !window.game.toolAvatar.built.bucket?.bucket?.busy, { timeout: 60000 }).catch(() => {});
await wait(800);
const st = await page.evaluate(() => ({
  busy: window.game.toolAvatar.built.bucket?.bucket?.busy ?? false,
  stamped: window.game.lastDemould?.stamped,
  outcome: window.game.lastDemould?.outcome,
  bucketVisible: window.game.toolAvatar.built.bucket?.group.visible,
  currentId: window.game.toolAvatar.currentId,
}));
console.log('  busy avant switch:', busyBefore, '| apres 3 s:', JSON.stringify(st));
if (st.busy) issues.push('[logic @changement-outil-pendant-seau] la sequence du seau reste GELEE apres un changement d outil (busy=true, tour jamais ecrite)');
if (st.outcome !== 'stuck' && st.stamped === false) issues.push('[logic @changement-outil-pendant-seau] la tour n a jamais ete stampee');

// ---------------------------------------------------------------------------
phase = 'changement-outil-pendant-plant';
console.log('== Changement d outil PENDANT le plantage ==');
await sel('shovel');
await page.mouse.move(CX + 40, CY + 40);
await wait(300);
await page.keyboard.press('KeyG');
await wait(120);            // l animation de plantage est en cours
await sel('trowel');        // on change d outil en plein geste
await wait(1500);
const pl = await page.evaluate(() => ({
  count: window.game.droppedTools.count,
  pendingGone: !window.game.toolAvatar._pending,
  plantActive: window.game.toolAvatar.plantAnim.active,
  dropActive: window.game.toolAvatar.dropAnim.active,
}));
console.log(' ', JSON.stringify(pl));
if (pl.plantActive || pl.dropActive) issues.push('[logic @changement-outil-pendant-plant] l animation de plantage continue de piloter le NOUVEL outil apres select()');
// on ramasse pour nettoyer
await page.evaluate(() => {
  const g = window.game;
  for (const it of [...g.droppedTools.items]) g.toolAvatar.pickUp(it);
});

// ---------------------------------------------------------------------------
phase = 'bord-domaine';
console.log('== Outils au bord du domaine ==');
await page.evaluate(() => {
  const g = window.game;
  const c = g.controls;
  c.goalTarget.set(-5.0, 1.2, -5.0); c.target.copy(c.goalTarget);
  c.goalDistance = c.distance = 8;
});
await wait(800);
for (const id of ['shovel', 'eraser', 'carve', 'water']) {
  await sel(id);
  await stroke([[CX, CY], [CX - 30, CY - 20]], 300);
}
// brosse directement hors du domaine
await page.evaluate(() => {
  const g = window.game;
  const B = g.tools.brush;
  B.sphere(g.tools.ctx, -5.15, 1.0, -5.15, 0.4, -255, {});
  B.sphere(g.tools.ctx, 5.2, 1.0, 5.2, 0.4, 200, { moisture: 0.1, packing: 0.2 });
  B.sphere(g.tools.ctx, 0, -0.5, 0, 0.3, -255, {});
  B.sphere(g.tools.ctx, 0, 4.2, 0, 0.3, 200, {});
  g.field.flushColumns();
});
console.log('  ok');

// ---------------------------------------------------------------------------
phase = 'seau-bord';
console.log('== Seau demoule au bord du domaine / contre un mur ==');
await page.evaluate(async () => {
  const g = window.game;
  const F = g.field;
  // un mur pour demouler contre
  const B = g.tools.brush;
  for (let y = 0; y < 8; y++) {
    B.sphere(g.tools.ctx, -4.4, F.surfaceHeightAt(-4.4, -4.4) + y * 0.05, -4.4, 0.3, 255, { moisture: 0.12, packing: 0.6 });
  }
  for (let d = 0; d < 0.5; d += 0.05) {
    for (let p = 0; p < 60; p++) g.moisture.wetSphere(-4.9, F.surfaceHeightAt(-4.9, -4.9) - d, -4.9, 0.45, 0.01);
  }
  g.tools.select('bucket');
  g.tools.setRadius(0.15);
  const t = g.tools.current;
  t.stuck = false; t.fill = 0;
  const hit = { point: { x: -4.9, y: F.surfaceHeightAt(-4.9, -4.9), z: -4.9 }, normal: { x: 0, y: 1, z: 0 } };
  g.tools.hit = hit;
  g.tools.stroke = { button: 0, lockY: null, lastPoint: { ...hit.point }, startPoint: { ...hit.point }, applied: 1 };
  t.down(g.tools.makeState(hit, 0));
  for (let i = 0; i < 200 && t.fill < 1; i++) {
    const a = i * 0.9;
    hit.point.x = -4.9 + Math.cos(a) * 0.1; hit.point.z = -4.9 + Math.sin(a) * 0.1;
    hit.point.y = F.surfaceHeightAt(hit.point.x, hit.point.z);
    t.apply(g.tools.makeState(hit, 1 / 30));
  }
  // demoulage COLLE au mur, pres du bord
  hit.point.x = -4.55; hit.point.z = -4.4;
  hit.point.y = F.surfaceHeightAt(-4.55, -4.4);
  t.up(g.tools.makeState(hit, 0));
  g.tools.endStroke();
});
await page.waitForFunction(() => !window.game?.toolAvatar?.bucket?.busy, { timeout: 60000 }).catch(() => {});
await wait(600);
console.log('  demoulage bord:', await page.evaluate(() => window.game.lastDemould?.outcome));

// ---------------------------------------------------------------------------
phase = 'pelle-dans-eau';
console.log('== Pelle plantee dans l eau ==');
await page.evaluate(() => {
  const c = window.game.controls;
  c.goalTarget.set(0, 0.9, 4.0); c.target.copy(c.goalTarget);  // vers la mer
  c.goalDistance = c.distance = 7;
});
await wait(900);
await sel('shovel');
// viser un point immerge
const wetHit = await page.evaluate(() => {
  const g = window.game;
  for (let z = 5.0; z > 0; z -= 0.2) {
    if (g.water.depthAt(0, z) > 0.06) {
      const y = g.field.surfaceHeightAt(0, z);
      g.tools.hit = { point: { x: 0, y, z }, normal: { x: 0, y: 1, z: 0 } };
      return { z, depth: g.water.depthAt(0, z) };
    }
  }
  return null;
});
console.log('  point immerge:', JSON.stringify(wetHit));
if (wetHit) {
  await page.evaluate(() => window.game.toolAvatar.plant('stab', window.game.tools.hit, window.game.tools.ctx));
  await page.waitForFunction(() => !window.game?.toolAvatar?._pending, { timeout: 15000 }).catch(() => {});
  await wait(2500);   // la maree l emporte ?
  const drifted = await page.evaluate(() => {
    const g = window.game;
    const it = g.droppedTools.items.find((i) => i.id === 'shovel');
    return it ? { x: it.obj.position.x.toFixed(2), z: it.obj.position.z.toFixed(2), visible: it.obj.visible } : null;
  });
  console.log('  apres 2,5 s dans l eau:', JSON.stringify(drifted));
  await page.evaluate(() => {
    const g = window.game;
    for (const it of [...g.droppedTools.items]) g.toolAvatar.pickUp(it);
  });
}

// ---------------------------------------------------------------------------
phase = 'sauvegarde-outil-plante';
console.log('== Sauvegarde avec un outil plante, rechargement ==');
await page.evaluate(() => {
  const c = window.game.controls;
  c.goalTarget.set(0, 1.35, 0); c.target.copy(c.goalTarget);
  c.goalDistance = c.distance = 10;
});
await wait(600);
await sel('shovel');
await page.mouse.move(CX, CY);
await wait(300);
await page.keyboard.press('KeyG');
await page.waitForFunction(() => !window.game?.toolAvatar?._pending, { timeout: 15000 }).catch(() => {});
await wait(800);
const savedState = await page.evaluate(async () => {
  const g = window.game;
  await g.save.save('bughunt');
  return { dropped: g.droppedTools.count, stowed: [...g.toolAvatar.stowed] };
});
console.log('  sauvegarde:', JSON.stringify(savedState));
// on ramasse, puis on recharge : la pelle doit etre de nouveau plantee
await page.evaluate(() => {
  const g = window.game;
  for (const it of [...g.droppedTools.items]) g.toolAvatar.pickUp(it);
});
await page.evaluate(() => window.game.save.load('bughunt'));
await wait(1500);
const reloaded = await page.evaluate(() => ({
  dropped: window.game.droppedTools.count,
  stowed: [...window.game.toolAvatar.stowed],
  handVisible: window.game.toolAvatar.current?.group.visible,
  currentId: window.game.toolAvatar.currentId,
}));
console.log('  recharge:', JSON.stringify(reloaded));
if (reloaded.dropped !== 1) issues.push('[logic @sauvegarde-outil-plante] l outil plante n est pas restaure au rechargement');

// et le cas inverse : outil EN MAIN a la sauvegarde, PLANTE au moment du load
phase = 'load-desync-stowed';
await page.evaluate(async () => {
  const g = window.game;
  for (const it of [...g.droppedTools.items]) g.toolAvatar.pickUp(it);
  await g.save.save('bughunt2');           // pelle en main, rien au sol
});
await page.mouse.move(CX, CY);
await wait(300);
await page.keyboard.press('KeyG');       // on la plante
await page.waitForFunction(() => !window.game?.toolAvatar?._pending, { timeout: 15000 }).catch(() => {});
await page.evaluate(() => window.game.save.load('bughunt2'));  // save sans outil au sol
await wait(1200);
const desync = await page.evaluate(() => ({
  dropped: window.game.droppedTools.count,
  stowed: [...window.game.toolAvatar.stowed],
  rootVisible: window.game.toolAvatar.root.visible,
}));
console.log('  desync:', JSON.stringify(desync));
if (desync.dropped === 0 && desync.stowed.length > 0) {
  issues.push('[logic @load-desync-stowed] apres rechargement, l outil courant reste marque "plante" (stowed) alors qu aucun outil n est au sol : outil invisible en main');
}

// ---------------------------------------------------------------------------
phase = 'vieille-sauvegarde';
console.log('== Sauvegarde d avant les nouveaux outils ==');
const oldOk = await page.evaluate(async () => {
  const g = window.game;
  const snap = await g.save.serialize();
  delete snap.droppedTools;      // une sauvegarde d avant les outils 3D
  delete snap.carried;
  try {
    await g.save.applySnapshot(snap);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  }
});
console.log('  ', JSON.stringify(oldOk));
if (!oldOk.ok) issues.push('[logic @vieille-sauvegarde] chargement d une vieille sauvegarde refuse : ' + oldOk.err);

// ---------------------------------------------------------------------------
phase = 'hud';
console.log('== HUD : tous les boutons ==');
await page.evaluate(() => {
  const hud = window.game.hud;
  hud.cycleTime(); hud.cycleTime();
  hud.cycleTide(); hud.cycleTide(); hud.cycleTide(); hud.cycleTide();
  hud.toggleSound(); hud.toggleSound();
  hud.toggleHelp(); hud.toggleHelp();
  hud.toggleDebug();
});
await wait(400);
await page.evaluate(() => window.game.hud.toggleDebug());
// clic sur chaque bouton d outil
await page.$$eval('.tool-btn', (btns) => btns.forEach((b) => b.click()));
await wait(300);
// bouton annuler quand il n y a rien a annuler
await page.evaluate(() => { window.game.tools.undo.clear(); });
await page.click('.tool-btn.small');
await wait(400);
// qualite : 3 niveaux
await page.evaluate(() => { window.game.setQuality(0); window.game.setQuality(1); window.game.setQuality(2); });
await wait(300);
// photo mode on/off + G pendant le mode photo
await page.keyboard.press('KeyP');
await wait(300);
await page.keyboard.press('KeyG');
await wait(300);
const photoPlant = await page.evaluate(() => window.game.droppedTools.count);
await page.keyboard.press('KeyP');
await wait(300);
if (photoPlant > 0) issues.push('[logic @hud] G plante l outil PENDANT le mode photo (outils desactives)');
console.log('  ok');

// ---------------------------------------------------------------------------
phase = 'sante';
console.log('\n== Sante finale ==');
const glErr = await page.evaluate(() => window.game.renderer.getContext().getError());
if (glErr !== 0) issues.push('[webgl] erreur GL code ' + glErr);
const shot = await page.screenshot({ type: 'png' });
writeFileSync(join(__dirname, 'bughunt.png'), shot);

console.log('\n===== PROBLEMES COLLECTES (' + issues.length + ') =====');
const freq = new Map();
for (const i of issues) freq.set(i, (freq.get(i) || 0) + 1);
for (const [msg, n] of freq) console.log(`  x${n}  ${msg.slice(0, 300)}`);

await browser.close();
process.exit(0);
