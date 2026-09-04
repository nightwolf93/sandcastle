/**
 * Test d'integration des OUTILS 3D VISIBLES.
 *
 * Comme les autres tests du depot, celui-ci encode des INVARIANTS DE
 * CONCEPTION, pas de la couverture. Chaque verification correspond a une
 * promesse tenue au joueur, et si elle casse, c'est le jeu qui casse :
 *
 *   1. l'outil est VU la ou il AGIT (point de travail = point vise) ;
 *   2. le seau se remplit, se retourne et demoule une tour qui tient DEBOUT ;
 *   3. le stamp de la tour tombe pendant que le seau la CACHE (phase de
 *      drainage) — c'est ce qui rend le remaillage asynchrone invisible ;
 *   4. les quatre issues du demoulage sont distinctes et lisibles : sable sec
 *      -> le seau revient PLEIN ; sable trempe -> la tour SORT FORMEE puis
 *      s'affaisse sous les yeux du joueur ;
 *   5. une pelle plantee ENTAILLE vraiment le sable, reste plantee quand on
 *      change d'outil, et se ramasse au clic ;
 *   6. le budget est tenu : un outil tenu reste sous 500 triangles et
 *      3 draw calls.
 *
 *   node tools/test-tools.mjs
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

const W = 1280, H = 800;
const url = process.env.SC_URL || 'http://localhost:5173/?fresh=1';
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

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('Chargement...');
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.toolAvatar, { timeout: 30000 });
await page.evaluate(() => { window.game._qualityProbe = -1; window.game.setQuality(2, false); });
console.log('Charge.\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attend la fin d'un geste de plantage / de pose. */
async function waitPlant() {
  // Deux temps : le geste doit d'abord COMMENCER. Attendre directement
  // « plus de geste en cours » renverrait vrai avant meme que la touche ait
  // ete traitee.
  await page.waitForFunction(
    () => !!window.game?.toolAvatar?._pending, { timeout: 5000 }
  ).catch(() => {});
  await page.waitForFunction(
    () => !window.game?.toolAvatar?._pending, { timeout: 30000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}

/** Attend la fin de la sequence de demoulage plutot que de deviner une duree. */
async function waitBucket() {
  await page.waitForFunction(
    () => !window.game?.toolAvatar?.bucket?.busy, { timeout: 60000 }
  ).catch(() => {});
}

/**
 * Joue un cycle de seau complet a un endroit donne, en pilotant les memes
 * points d'entree que la souris (`down` / `apply` / `up`).
 */
async function bucketCycle(x, z, radius, targetMoist) {
  return page.evaluate(async ({ x, z, radius, targetMoist }) => {
    const g = window.game;
    const F = g.field;
    // On amene l'humidite de la colonne a la valeur voulue : c'est elle, et
    // elle seule, qui decide de l'issue du demoulage.
    const probe = () => F.averageMoisture(x, F.surfaceHeightAt(x, z) - 0.15, z, 0.3);
    for (let pass = 0; pass < 400 && probe() < targetMoist; pass++) {
      for (let d = 0; d < 0.5; d += 0.05) {
        g.moisture.wetSphere(x, F.surfaceHeightAt(x, z) - d, z, 0.45, 0.008);
      }
    }
    g.tools.select('bucket');
    g.tools.setRadius(radius);
    const t = g.tools.current;
    t.stuck = false; t.fill = 0;
    const hit = { point: { x, y: F.surfaceHeightAt(x, z), z }, normal: { x: 0, y: 1, z: 0 } };
    g.tools.hit = hit;
    g.tools.stroke = {
      button: 0, lockY: null,
      lastPoint: { ...hit.point }, startPoint: { ...hit.point }, applied: 1,
    };
    t.down(g.tools.makeState(hit, 0));
    // On balaie un petit cercle plutot que de forer un puits : un joueur ne
    // tient jamais la souris parfaitement immobile, et un trou plus large que
    // la brosse cesse de rendre du sable.
    for (let i = 0; i < 300 && t.fill < 1; i++) {
      const a = i * 0.9;
      const px = x + Math.cos(a) * radius * 0.7;
      const pz = z + Math.sin(a) * radius * 0.7;
      hit.point.x = px; hit.point.z = pz;
      hit.point.y = F.surfaceHeightAt(px, pz);
      t.apply(g.tools.makeState(hit, 1 / 30));
    }
    const fill = t.fill;
    // On demoule un peu plus loin, sur du sol intact.
    hit.point.x = x + 0.8; hit.point.z = z;
    hit.point.y = F.surfaceHeightAt(x + 0.8, z);
    const before = hit.point.y;
    t.up(g.tools.makeState(hit, 0));
    g.tools.endStroke();
    return { fill, before, at: { x: x + 0.8, z } };
  }, { x, z, radius, targetMoist });
}

async function surfaceAt(x, z) {
  return page.evaluate(({ x, z }) => window.game.field.surfaceHeightAt(x, z), { x, z });
}

// ---------------------------------------------------------------------------
console.log('== L outil est un objet : budget et point de travail ==');
{
  const budget = await page.evaluate(async () => {
    const g = window.game;
    const ids = ['shovel', 'hand', 'can', 'water', 'bucket', 'trowel', 'carve', 'rake'];
    const rows = [];
    for (const id of ids) {
      g.tools.select(id);
      await new Promise((r) => requestAnimationFrame(r));
      const entry = g.toolAvatar.built[id];
      if (!entry) { rows.push({ id, tris: -1, calls: -1 }); continue; }
      let tris = 0, calls = 0;
      entry.group.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const a = o.geometry;
        tris += (a.index ? a.index.count : a.attributes.position.count) / 3;
        calls++;
      });
      rows.push({ id, tris: Math.round(tris), calls });
    }
    return rows;
  });
  for (const r of budget) console.log(`    ${r.id.padEnd(8)} ${String(r.tris).padStart(4)} tri, ${r.calls} draw`);
  const worstTri = Math.max(...budget.map((r) => r.tris));
  const worstCalls = Math.max(...budget.map((r) => r.calls));
  check('un outil tenu reste sous 500 triangles', worstTri > 0 && worstTri < 500,
    `${worstTri} au pire`);
  check('un outil tenu reste sous 4 draw calls', worstCalls <= 3, `${worstCalls} au pire`);

  // Le point de travail DOIT coincider avec le point vise : des que l'outil
  // visible et la brosse invisible divergent, tout l'effort est perdu.
  const tip = await page.evaluate(async () => {
    const g = window.game;
    g.tools.select('shovel');
    const x = -0.6, z = 0.4;
    const hit = { point: { x, y: g.field.surfaceHeightAt(x, z), z }, normal: { x: 0, y: 1, z: 0 } };
    g.tools.hit = hit;
    for (let i = 0; i < 90; i++) {
      g.toolAvatar.update(1 / 60, g.tools);
      await new Promise((r) => setTimeout(r, 0));
    }
    const t = g.toolAvatar.tipWorld();
    return Math.hypot(t.x - x, t.y - hit.point.y, t.z - z);
  });
  check('le point de travail tombe sur le point vise', tip < 0.02,
    `ecart ${(tip * 1000).toFixed(1)} mm`);
}

// ---------------------------------------------------------------------------
console.log('\n== Le seau : un cycle complet produit une tour debout ==');
{
  const r = await bucketCycle(-1.4, -1.4, 0.18, 0.13);
  const d0 = await page.evaluate(() => window.game.lastDemould);
  await waitBucket();
  await wait(1200);
  const after = await surfaceAt(r.at.x, r.at.z);
  const dem = await page.evaluate(() => window.game.lastDemould);
  console.log(`    remplissage ${(r.fill * 100).toFixed(0)} %, humidite `
    + `${(dem.moisture * 100).toFixed(1)} %, issue « ${dem.outcome} »`);
  check('le seau se remplit vraiment', r.fill > 0.4, `${(r.fill * 100).toFixed(0)} %`);
  check('l issue est un demoulage reussi', dem.outcome === 'clean' || dem.outcome === 'slump',
    dem.outcome);
  check('une tour se dresse a l endroit vise', after - r.before > 0.08,
    `+${((after - r.before) * 100).toFixed(1)} cm pour ${(dem.height * 100).toFixed(0)} cm moules`);
  check('stampBucket tombe pendant la phase de drainage', dem.stampPhase === 'settle',
    `phase « ${dem.stampPhase} »`);
  check('l issue est decidee au relachement, pas au stamp', d0.outcome === dem.outcome,
    `${d0.outcome} -> ${dem.outcome}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Sable trop sec : le seau revient plein ==');
{
  // Aucun arrosage : la plage haute est a la saturation residuelle (3,5 %).
  const r = await bucketCycle(2.6, -2.9, 0.18, 0);   // aucun arrosage
  await waitBucket();
  await wait(900);
  const st = await page.evaluate((rr) => ({
    dem: window.game.lastDemould,
    fill: window.game.tools.current.fill,
    stuck: !!window.game.tools.current.stuck,
    rigFill: window.game.toolAvatar.bucket.fill,
    sandVisible: window.game.toolAvatar.bucket.sand.visible,
    surface: window.game.field.surfaceHeightAt(rr.at.x, rr.at.z),
  }), r);
  console.log(`    humidite ${(st.dem.moisture * 100).toFixed(1)} %, issue « ${st.dem.outcome} »`);
  check('sable sec -> issue « stuck »', st.dem.outcome === 'stuck', st.dem.outcome);
  check('aucune tour n est ecrite', st.dem.stamped === false && st.surface - r.before < 0.02,
    `${((st.surface - r.before) * 100).toFixed(1)} cm`);
  check('le seau revient PLEIN, et il est bloque', st.stuck && st.fill > 0.3,
    `fill ${(st.fill * 100).toFixed(0)} %`);
  check('le sable reste visible dans le seau', st.sandVisible && st.rigFill > 0.3,
    `rig ${(st.rigFill * 100).toFixed(0)} %`);

  // La sortie de secours : clic droit pour vider.
  const emptied = await page.evaluate(() => {
    const g = window.game;
    const x = 2.6, z = -2.4;
    const hit = { point: { x, y: g.field.surfaceHeightAt(x, z), z }, normal: { x: 0, y: 1, z: 0 } };
    g.tools.hit = hit;
    g.tools.stroke = {
      button: 2, lockY: null,
      lastPoint: { ...hit.point }, startPoint: { ...hit.point }, applied: 1,
    };
    g.tools.current.down(g.tools.makeState(hit, 0));
    g.tools.endStroke();
    return { fill: g.tools.current.fill, stuck: !!g.tools.current.stuck };
  });
  check('le clic droit vide le seau et le debloque',
    emptied.fill === 0 && !emptied.stuck, JSON.stringify(emptied));
}

// ---------------------------------------------------------------------------
console.log('\n== Sable trop mouille : la tour sort, puis s affaisse ==');
{
  // Le sable simplement trempe s'egoutte maintenant dans le seau. Il faut une
  // vraie boue presque liquide pour tester l'issue d'effondrement.
  const r = await bucketCycle(-2.9, 2.4, 0.20, 0.95);
  // On saisit la tour A L INSTANT du moulage : l'effondrement commence des
  // que la simulation granulaire la voit, c'est-a-dire bien avant que le seau
  // ait fini de se relever.
  await page.waitForFunction(
    () => window.game?.lastDemould?.stamped === true, { timeout: 60000 }
  ).catch(() => {});
  const justAfter = await surfaceAt(r.at.x, r.at.z);
  await waitBucket();
  await wait(6000);   // on ne code aucun effondrement : la physique travaille
  const later = await surfaceAt(r.at.x, r.at.z);
  const dem = await page.evaluate(() => window.game.lastDemould);
  console.log(`    humidite ${(dem.moisture * 100).toFixed(1)} %, issue « ${dem.outcome} », `
    + `moule ${(dem.height * 100).toFixed(0)} cm, sommet `
    + `${((justAfter - r.before) * 100).toFixed(0)} -> ${((later - r.before) * 100).toFixed(0)} cm`);
  check('sable trempe -> issue « collapse »', dem.outcome === 'collapse', dem.outcome);
  check('la tour a bien ete moulee', dem.stamped === true);
  check('elle sort formee puis s affaisse sous les yeux du joueur',
    justAfter - later > 0.02, `-${((justAfter - later) * 100).toFixed(1)} cm`);
  check('il ne reste qu une galette, loin de la hauteur moulee',
    (later - r.before) < dem.height * 0.6,
    `${((later - r.before) * 100).toFixed(0)} cm restants sur ${(dem.height * 100).toFixed(0)}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Planter la pelle : G, une entaille, et elle reste la ==');
{
  // On vise avec la vraie souris : c'est `ToolManager.hit` qui sert d'ancre.
  await page.evaluate(() => {
    const c = window.game.controls;
    c.goalTarget.set(0, 1.45, 0); c.target.copy(c.goalTarget);
    c.goalDistance = c.distance = 6.0;
    c.goalPolar = c.polar = 0.95;
    c.goalAzimuth = c.azimuth = Math.PI * 0.78;
  });
  await wait(900);
  await page.evaluate(() => window.game.tools.select('shovel'));
  await page.mouse.move(W / 2, H * 0.55);
  await wait(400);
  const anchor = await page.evaluate(() => {
    const h = window.game.tools.hit;
    return h ? { x: h.point.x, y: h.point.y, z: h.point.z } : null;
  });
  check('la pelle vise bien le sable', !!anchor);

  const beforeSurf = anchor ? await surfaceAt(anchor.x, anchor.z) : 0;
  await page.keyboard.press('KeyG');
  await waitPlant();

  const planted = await page.evaluate(() => {
    const g = window.game;
    const it = g.droppedTools.items[g.droppedTools.items.length - 1];
    return {
      count: g.droppedTools.count,
      stowed: g.toolAvatar.isStowed,
      id: it?.id,
      pos: it ? { x: it.obj.position.x, y: it.obj.position.y, z: it.obj.position.z } : null,
      // « legerement de travers » : un objet parfaitement d aplomb dit
      // « un moteur m a place ici ».
      tilt: it ? Math.acos(Math.min(1, Math.abs(
        new (it.obj.up.constructor)(0, 1, 0).applyQuaternion(it.obj.quaternion).y))) : 0,
      visible: !!it?.obj.visible,
    };
  });
  check('un exemplaire de pelle est au sol', planted.count === 1 && planted.id === 'shovel',
    `${planted.count} outil(s)`);
  check('l outil quitte la main', planted.stowed === true);
  check('elle n est ni verticale ni d aplomb',
    planted.tilt > 0.08 && planted.tilt < 0.7, `${(planted.tilt * 57.3).toFixed(1)} deg`);

  const afterSurf = anchor ? await surfaceAt(anchor.x, anchor.z) : 0;
  check('la lame a REELLEMENT entaille le champ de voxels',
    beforeSurf - afterSurf > 0.015,
    `${((beforeSurf - afterSurf) * 100).toFixed(1)} cm d entaille`);

  // On change d'outil : la pelle plantee doit rester exactement ou elle est.
  const p0 = planted.pos;
  await page.evaluate(() => window.game.tools.select('trowel'));
  await wait(1500);
  const still = await page.evaluate(() => {
    const g = window.game;
    const it = g.droppedTools.items[0];
    return {
      count: g.droppedTools.count,
      pos: it ? { x: it.obj.position.x, y: it.obj.position.y, z: it.obj.position.z }
        : { x: 9e9, y: 9e9, z: 9e9 },
    };
  });
  const moved = Math.hypot(still.pos.x - p0.x, still.pos.y - p0.y, still.pos.z - p0.z);
  check('elle reste plantee quand on change d outil',
    still.count === 1 && moved < 0.05, `deplacement ${(moved * 100).toFixed(1)} cm`);

  // Elle suit le terrain : on creuse dessous, elle descend.
  await page.evaluate(({ x, z }) => {
    const g = window.game;
    for (let i = 0; i < 6; i++) {
      g.tools.brush.sphere(g.tools.ctx, x, g.field.surfaceHeightAt(x, z) - i * 0.05, z,
        0.28, -255, { hardness: 0.4 });
    }
    g.field.flushColumns();
  }, { x: p0.x, z: p0.z });
  await wait(2000);
  const sunk = await page.evaluate(() => window.game.droppedTools.items[0].obj.position.y);
  check('elle descend avec le terrain qu on creuse sous elle', p0.y - sunk > 0.05,
    `${((p0.y - sunk) * 100).toFixed(1)} cm`);

  // Ramassage : un clic sur l'objet le reprend, et ne creuse pas.
  const screen = await page.evaluate(({ W, H }) => {
    const g = window.game;
    const it = g.droppedTools.items[0];
    const v = it.obj.position.clone().project(g.camera);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  }, { W, H });
  await page.mouse.move(screen.x, screen.y);
  await wait(250);
  const hovered = await page.evaluate(() => !!window.game.droppedTools.hovered);
  check('l outil au sol se surligne au survol', hovered);
  // Le nombre de gestes annulables avant / apres : c'est la mesure exacte de
  // « le ramassage n'a pas creuse ». Comparer la hauteur du sable ne dirait
  // rien ici, le trou qu'on vient de faire est encore en train de s'ebouler.
  const undoBefore = await page.evaluate(() => window.game.tools.undo.groups.length);
  await page.mouse.down(); await page.mouse.up();
  await wait(900);
  const picked = await page.evaluate(() => ({
    count: window.game.droppedTools.count,
    tool: window.game.tools.current.id,
    stowed: window.game.toolAvatar.isStowed,
    undo: window.game.tools.undo.groups.length,
  }));
  check('le clic la reprend en main', picked.count === 0 && picked.tool === 'shovel'
    && picked.stowed === false, JSON.stringify(picked));
  check('le ramassage ne creuse PAS sous l outil', picked.undo === undoBefore,
    `${undoBefore} -> ${picked.undo} gestes annulables`);
}

// ---------------------------------------------------------------------------
console.log('\n== Maj+G : poser a plat plutot que planter ==');
{
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
  await page.evaluate(() => window.game.tools.select('shovel'));
  await page.mouse.move(W * 0.46, H * 0.58);
  await wait(400);
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyG');
  await page.keyboard.up('Shift');
  await waitPlant();
  const laid = await page.evaluate(() => {
    const g = window.game;
    const it = g.droppedTools.items[0];
    if (!it) return null;
    const V = g.tools.raycaster.ray.origin.constructor;
    // Angle du manche avec la verticale : couchee, la pelle est a ~90 deg.
    const axis = new V(0, 1, 0).applyQuaternion(it.obj.quaternion);
    return { count: g.droppedTools.count, tilt: Math.acos(Math.min(1, Math.abs(axis.y))) };
  });
  check('Maj+G couche l outil au lieu de le planter',
    laid && laid.count === 1 && laid.tilt > 1.2,
    laid ? `${(laid.tilt * 57.3).toFixed(0)} deg de la verticale` : 'aucun outil pose');

  // Un seau, lui, se POSE DROIT : « couche » n'est pas « pose ».
  await page.evaluate(() => window.game.tools.select('bucket'));
  await page.mouse.move(W * 0.56, H * 0.58);
  await wait(400);
  await page.keyboard.press('KeyG');
  await waitPlant();
  const bk = await page.evaluate(() => {
    const g = window.game;
    const it = g.droppedTools.items.find((i) => i.id === 'bucket');
    if (!it) return null;
    const V = g.tools.raycaster.ray.origin.constructor;
    const axis = new V(0, 1, 0).applyQuaternion(it.obj.quaternion);
    return { tilt: Math.acos(Math.min(1, Math.abs(axis.y))) };
  });
  check('un seau se pose DROIT, il ne se couche pas',
    bk && bk.tilt < 0.2, bk ? `${(bk.tilt * 57.3).toFixed(0)} deg` : 'aucun seau pose');
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
}

// ---------------------------------------------------------------------------
console.log('\n== Plafond des outils au sol ==');
{
  const cap = await page.evaluate(async () => {
    const g = window.game;
    const V = g.tools.raycaster.ray.origin.constructor;   // THREE.Vector3
    const Q = g.toolAvatar.plantAnim.quat.constructor;    // THREE.Quaternion
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const x = 3.2 * Math.cos(a), z = 3.2 * Math.sin(a);
      g.droppedTools.add('carve',
        new V(x, g.field.surfaceHeightAt(x, z), z), new Q(), 1, {});
    }
    return g.droppedTools.count;
  });
  check('le chantier ne devient jamais un debarras', cap <= 12, `${cap} outils`);
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
}

// ---------------------------------------------------------------------------
console.log('\n== Changer d outil pendant la sequence du seau ==');
{
  // Regle : une sequence de demoulage commencee doit ABOUTIR, meme si le
  // joueur prend un autre outil en plein retournement. Avant, la sequence
  // gelait en l'air : seau invisible, tour jamais ecrite, seau bloque.
  const r = await bucketCycle(1.6, 1.8, 0.16, 0.13);
  await wait(250);                      // la sequence est en cours
  const busyAtSwitch = await page.evaluate(() => {
    const busy = window.game.toolAvatar.built.bucket.bucket.busy;
    window.game.tools.select('shovel'); // on change d'outil en plein vol
    return busy;
  });
  const finished = await page.waitForFunction(
    () => !window.game.toolAvatar.built.bucket.bucket.busy, { timeout: 60000 }
  ).then(() => true).catch(() => false);
  await wait(800);
  const st = await page.evaluate((rr) => ({
    stamped: window.game.lastDemould?.stamped,
    bg: !!window.game.toolAvatar._bg,
    surface: window.game.field.surfaceHeightAt(rr.at.x, rr.at.z),
  }), r);
  check('la sequence aboutit en arriere-plan', busyAtSwitch && finished,
    busyAtSwitch ? '' : 'la sequence etait deja finie au moment du switch');
  check('la tour est bien ecrite malgre le changement d outil',
    st.stamped === true && st.surface - r.before > 0.05,
    `+${((st.surface - r.before) * 100).toFixed(1)} cm`);
  check('le seau d arriere-plan est range apres la sequence', st.bg === false);
}

// ---------------------------------------------------------------------------
console.log('\n== Changer d outil pendant le plantage ==');
{
  // Regle : le geste de pose aboutit immediatement (l'outil ne s'evapore
  // pas), et l'animation morte ne pilote plus le NOUVEL outil.
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
  await page.evaluate(() => window.game.tools.select('shovel'));
  await page.mouse.move(W * 0.5, H * 0.55);
  await wait(400);
  await page.keyboard.press('KeyG');
  await wait(120);                       // l'animation vient de commencer
  const mid = await page.evaluate(() => {
    const g = window.game;
    const wasAnimating = g.toolAvatar.plantAnim.active || g.toolAvatar.dropAnim.active
      || !!g.toolAvatar._pending;
    g.tools.select('trowel');            // on coupe le geste
    return {
      wasAnimating,
      animAfter: g.toolAvatar.plantAnim.active || g.toolAvatar.dropAnim.active,
      pending: !!g.toolAvatar._pending,
      count: g.droppedTools.count,
      slotted: true,
    };
  });
  check('le geste coupe aboutit : la pelle est au sol', mid.count === 1
    && mid.pending === false, JSON.stringify(mid));
  check('l animation de plantage ne pilote plus le nouvel outil',
    mid.animAfter === false, mid.wasAnimating ? '' : '(geste deja fini au switch)');
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
}

// ---------------------------------------------------------------------------
console.log('\n== Sauvegarde : outil plante, vieux format, etat du seau ==');
{
  // 1. Un outil plante est sauvegarde et restaure.
  await page.evaluate(() => window.game.tools.select('shovel'));
  await page.mouse.move(W * 0.5, H * 0.55);
  await wait(400);
  await page.keyboard.press('KeyG');
  await waitPlant();
  const savedDropped = await page.evaluate(async () => {
    const g = window.game;
    await g.save.save('test-outils');
    return g.droppedTools.count;
  });
  // On ramasse tout, puis on recharge : la pelle doit etre de nouveau au sol.
  await page.evaluate(() => window.game.droppedTools.deserialize([]));
  await page.evaluate(() => window.game.save.load('test-outils'));
  await wait(800);
  const restored = await page.evaluate(() => window.game.droppedTools.count);
  check('un outil plante survit a la sauvegarde', savedDropped === 1 && restored === 1,
    `${savedDropped} -> ${restored}`);

  // 2. Desynchronisation : outil PLANTE au moment ou on charge une sauvegarde
  //    SANS outil au sol -> l'etat « plante » doit etre nettoye, sinon
  //    l'outil courant reste invisible en main.
  await page.evaluate(async () => {
    const g = window.game;
    g.droppedTools.deserialize([]);      // rien au sol
    await g.save.save('test-outils-vide');
  });
  await page.mouse.move(W * 0.5, H * 0.55);
  await wait(300);
  await page.keyboard.press('KeyG');     // pelle plantee...
  await waitPlant();
  await page.evaluate(() => window.game.save.load('test-outils-vide'));
  await wait(800);
  const sync = await page.evaluate(() => ({
    dropped: window.game.droppedTools.count,
    stowed: [...window.game.toolAvatar.stowed],
  }));
  check('apres rechargement, aucun outil fantome « plante »',
    sync.dropped === 0 && sync.stowed.length === 0, JSON.stringify(sync));

  // 3. Une sauvegarde d AVANT les outils 3D (sans champ droppedTools) doit
  //    se charger sans erreur.
  const oldOk = await page.evaluate(async () => {
    const g = window.game;
    const snap = await g.save.serialize();
    delete snap.droppedTools;
    delete snap.carried;
    try { await g.save.applySnapshot(snap); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  });
  check('une sauvegarde d avant les outils se charge', oldOk.ok === true,
    oldOk.err || '');

  // 4. Le rig VISIBLE du seau est remis a plat par le chargement : un seau
  //    plein a l'ecran avec un etat vide serait un mensonge.
  const rigReset = await page.evaluate(async () => {
    const g = window.game;
    g.tools.select('bucket');
    g.tools.current.fill = 0.7; g.tools.current.stuck = true;
    g.toolAvatar.bucket.setFill(0.7, 0.12);
    await g.save.load('test-outils-vide');
    return {
      fill: g.tools.current.fill, stuck: !!g.tools.current.stuck,
      rigFill: g.toolAvatar.bucket.fill, sandVisible: g.toolAvatar.bucket.sand.visible,
    };
  });
  check('le chargement remet le seau a plat, etat ET visuel',
    rigReset.fill === 0 && !rigReset.stuck && rigReset.rigFill === 0
    && !rigReset.sandVisible, JSON.stringify(rigReset));
  await page.evaluate(async () => {
    await window.game.save.remove('test-outils');
    await window.game.save.remove('test-outils-vide');
    window.game.tools.select('shovel');
  });
}

// ---------------------------------------------------------------------------
console.log('\n== Annulation : bouton du HUD, mode photo, affaissement ==');
{
  // doUndo est le chemin UNIQUE (Ctrl+Z et bouton du HUD) : a vide il ne
  // fait rien — surtout pas un remaillage complet.
  const undoEmpty = await page.evaluate(() => {
    const g = window.game;
    g.tools.undo.clear();
    const label = g.tools.doUndo();
    return { label, queue: g.mesher.busy };
  });
  check('annuler a vide ne fait rien', undoEmpty.label === null, JSON.stringify(undoEmpty));

  // G en mode photo : les outils sont desactives, G ne doit pas entailler le
  // sable en douce.
  const photo = await page.evaluate(() => {
    const g = window.game;
    g.togglePhotoMode();
    const hit = { point: { x: 0.3, y: g.field.surfaceHeightAt(0.3, 0.3), z: 0.3 },
      normal: { x: 0, y: 1, z: 0 } };
    g.tools.hit = hit;
    return g.photoMode;
  });
  await page.keyboard.press('KeyG');
  await wait(600);
  const photoPlanted = await page.evaluate(() => {
    const n = window.game.droppedTools.count;
    window.game.togglePhotoMode();
    return n;
  });
  check('G ne plante rien en mode photo', photo === true && photoPlanted === 0,
    `${photoPlanted} outil(s) plante(s)`);

  // Ctrl+Z PENDANT l'affaissement d'une tour trop mouillee : la tour est
  // annulee et l'affaissement cesse d'ecrire — pas de galette fantome, pas de
  // groupe d'annulation orphelin.
  const r = await bucketCycle(-1.6, 2.9, 0.18, 0.95);
  await page.waitForFunction(
    () => window.game?.lastDemould?.stamped === true, { timeout: 60000 }
  ).catch(() => {});
  const undone = await page.evaluate(() => {
    const label = window.game.tools.doUndo();   // en plein affaissement
    return label;
  });
  await waitBucket();
  await wait(2500);
  const afterUndo = await page.evaluate((rr) => ({
    current: window.game.tools.undo.current,
    surface: window.game.field.surfaceHeightAt(rr.at.x, rr.at.z),
  }), r);
  check('Ctrl+Z pendant l affaissement annule le demoulage', undone === 'Demoulage', String(undone));
  check('l affaissement n ecrit plus apres l annulation',
    Math.abs(afterUndo.surface - r.before) < 0.06,
    `${((afterUndo.surface - r.before) * 100).toFixed(1)} cm residuels`);
  check('aucun groupe d annulation orphelin', afterUndo.current === null);
}

// ---------------------------------------------------------------------------
console.log('\n== Particules ==');
{
  const parts = await page.evaluate(async () => {
    const g = window.game;
    const before = g.particles.count;
    g.particles.burst(0, 0, 1.8, 0, 200, { speed: 1.2, spread: 0.8 });
    const after = g.particles.count;
    await new Promise((r) => setTimeout(r, 2500));
    return { before, after, max: g.particles.max, later: g.particles.count,
      draw: g.particles.points.visible ? 1 : 0 };
  });
  check('le systeme de particules emet', parts.after - parts.before === 200,
    `${parts.after - parts.before}`);
  check('le pool ne grossit jamais et se vide', parts.later < parts.after
    && parts.after <= parts.max, `${parts.later} vivantes sur ${parts.max}`);
  check('un seul draw call pour tous les grains', parts.draw === 1);
}

// ---------------------------------------------------------------------------
console.log('\n== Cout ==');
{
  const cost = await page.evaluate(() => {
    const g = window.game;
    g.tools.select('shovel');
    // Pool a moitie plein : le pire cas realiste.
    for (let i = 0; i < 1500; i++) {
      g.particles.spawn(0, (Math.random() - 0.5) * 6, 2.2, (Math.random() - 0.5) * 6,
        0, 0.4, 0);
    }
    const bench = (fn, n) => {
      fn();                              // rechauffe
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      return (performance.now() - t0) / n;
    };
    // dt minuscule : on mesure le cout de la passe, pas la mort des particules.
    const particles = bench(() => g.particles.update(1 / 600), 60);
    const avatar = bench(() => g.toolAvatar.update(1 / 600, g.tools), 60);
    const dropped = bench(() => g.droppedTools.update(1 / 600), 60);
    return { particles, avatar, dropped, alive: g.particles.count };
  });
  console.log(`    particules (${cost.alive} vivantes) ${cost.particles.toFixed(3)} ms`
    + ` | avatar ${cost.avatar.toFixed(3)} ms | outils au sol ${cost.dropped.toFixed(3)} ms`);
  // Seuil large : on mesure sous rendu logiciel, sur une machine deja a genoux.
  check('le cout CPU par frame reste marginal',
    cost.particles + cost.avatar + cost.dropped < 2.0,
    `${(cost.particles + cost.avatar + cost.dropped).toFixed(3)} ms au total`);
}

// ---------------------------------------------------------------------------
console.log('\n== Sante generale ==');
{
  const stats = await page.evaluate(() => ({
    fps: window.game.stats.fps,
    calls: window.game.renderer.info.render.calls,
    glError: window.game.renderer.getContext().getError(),
  }));
  console.log('  ' + JSON.stringify(stats, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
  check('aucune erreur WebGL', stats.glError === 0, 'code ' + stats.glError);
  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// --- deux images du chantier, pour juger a l oeil --------------------------
//
// La premiere de pres (est-ce que l'objet est bien fait ?), la seconde a la
// DISTANCE DE TRAVAIL (est-ce qu'il se lit encore a 18 pixels ?). C'est la
// seconde qui compte : c'est celle que le joueur a sous les yeux.
await page.evaluate(async () => {
  const g = window.game;
  const F = g.field;
  const V = g.tools.raycaster.ray.origin.constructor;
  const Q = g.toolAvatar.plantAnim.quat.constructor;
  const items = [
    ['shovel', -0.62, 0.30, 0.30, 1.1],
    ['rake', 0.80, -0.10, 0.34, -0.5],
    ['carve', 0.10, 0.70, 0.22, 2.4],
    ['can', 0.95, 0.55, 0.00, 0.9],
  ];
  for (const [id, x, z, tilt, yaw] of items) {
    const q = new Q().setFromAxisAngle(new V(0, 1, 0), yaw);
    q.multiply(new Q().setFromAxisAngle(new V(1, 0, 0.28).normalize(), tilt));
    g.droppedTools.add(id, new V(x, F.surfaceHeightAt(x, z), z), q, 1, {});
  }
  g.tools.select('bucket');
  g.tools.setRadius(0.16);
  g.tools.current.fill = 0.62;
  g.tools.current.fillMoist = 0.13;
  g.toolAvatar.bucket.setFill(0.62, 0.13);
  g.dayT = 0.42;
  g.sky.update(g.dayT, true);
});

async function frame(name, dist, polar) {
  await page.evaluate(({ dist, polar }) => {
    const c = window.game.controls;
    c.goalTarget.set(0, 1.5, 0); c.target.copy(c.goalTarget);
    c.goalDistance = c.distance = dist;
    c.goalPolar = c.polar = polar;
    c.goalAzimuth = c.azimuth = Math.PI * 0.78;
  }, { dist, polar });
  await page.mouse.move(W * 0.5, H * 0.52);
  await wait(2600);
  writeFileSync(join(OUT, name), await page.screenshot({ type: 'png' }));
  console.log('  capture : shots/' + name);
}
console.log('');
await frame('outils.png', 2.4, 1.10);
await frame('outils-diorama.png', 9.5, 0.95);

// Troisieme image : la pelle EN MAIN, chargee. Le volume porte
// (`carried.volume`) n'avait jusqu'ici aucune representation ; il est
// desormais une calotte de sable posee dans le creux de la lame, dont la
// couleur dit l'humidite.
await page.evaluate(() => {
  const g = window.game;
  g.tools.select('shovel');
  g.tools.setRadius(0.2);
  g.carried.volume = 0.30;
  g.carried.moisture = 0.14;
});
await frame('outils-pelle.png', 2.6, 1.02);

if (errors.length) {
  console.log('\n  Erreurs :');
  for (const e of errors.slice(0, 10)) console.log('   - ' + e);
}

await browser.close();
console.log(failures === 0
  ? '\nTous les tests d outils passent.\n'
  : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
