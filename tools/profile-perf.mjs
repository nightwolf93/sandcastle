/**
 * Profil CPU par sous-systeme, en headless (SwiftShader).
 *
 * Le fps headless est ~10 : c'est NORMAL, on juge sur les millisecondes CPU
 * par sous-systeme, pas sur le fps. Le script lit les accumulateurs de
 * Game.perf (instrumentation dans Game.js) et enveloppe a chaud les methodes
 * internes de Water/Waves pour le detail — sans toucher a leur code source.
 *
 *   node tools/profile-perf.mjs [secondes par phase = 12] [url]
 *
 * NB : sur le serveur `vite dev`, toute modification de fichier par un autre
 * processus declenche un rechargement HMR qui tue la mesure. Preferer un
 * build : `npm run build && npm run preview`, puis profiler sur le port 4173.
 */

import puppeteer from 'puppeteer';

const SECONDS = +(process.argv[2] || 12);
const URL = process.argv[3] || 'http://localhost:4173/?fresh=1';

const browser = await puppeteer.launch({
  headless: 'shell',
  protocolTimeout: 240000,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('[err] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console] ' + m.text()); });

console.log('Chargement...');
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });

// Enveloppes de mesure fine sur l'eau / la houle / le decor.
await page.evaluate(() => {
  const g = window.game;
  g._qualityProbe = -1;
  g.setQuality(2, false);
  const acc = (window.__wp = {});
  const wrap = (obj, name, key) => {
    const fn = obj[name].bind(obj);
    acc[key] = 0;
    acc[key + 'N'] = 0;
    obj[name] = function (...a) {
      const t = performance.now();
      const r = fn(...a);
      acc[key] += performance.now() - t;
      acc[key + 'N']++;
      return r;
    };
  };
  const w = g.water;
  wrap(w, 'computeScanRanges', 'scan');
  wrap(w, 'flux', 'flux');
  wrap(w, 'integrate', 'integrate');
  wrap(w, 'breaking', 'breaking');
  wrap(w, 'erode', 'erode');
  wrap(w, 'undermine', 'undermine');
  wrap(w, 'advect', 'advect');
  wrap(w, 'infiltrate', 'infiltrate');
  wrap(w, 'seep', 'seep');
  wrap(w.waves, 'update', 'wavesUpd');
  wrap(w.waves, 'buildBands', 'bands');
  wrap(w.waves, 'applyGeneration', 'gen');
  wrap(g.granular, 'step', 'granStep');
  wrap(g.props, 'refresh', 'propsRefresh');
  wrap(g.particles, 'update', 'particles');
  wrap(g.toolAvatar, 'update', 'avatar');
  wrap(g.waterRenderer, 'buildRenderLevel', 'renderLevel');
  wrap(g.mesher, 'dispatch', 'dispatch');
  wrap(g.mesher, 'prioritize', 'prioritize');
  wrap(g.field, 'extractChunk', 'extract');
  wrap(g.terrain, 'update', 'terrainUp');
  wrap(g.moisture, 'tick', 'moistTick');
});

async function phase(label, setup) {
  if (setup) await page.evaluate(setup);
  await new Promise((r) => setTimeout(r, 2000)); // regime etabli
  await page.evaluate(() => {
    window.game.perfReset();
    for (const k in window.__wp) window.__wp[k] = 0;
  });
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const r = await page.evaluate(() => {
    const g = window.game;
    return {
      perf: { ...g.perf },
      wp: { ...window.__wp },
      fps: g.stats.fps,
      wetCells: g.stats.wetCells,
      granActive: g.granular.stats.active, urgent: g.moisture.urgent.length, cols: g.moisture.stats.columns,
      meshQueue: g.mesher.busy,
      meshAvgMs: g.mesher.stats.avgMs,
      substeps: g.water.substepCount,
      seaState: g.water.waves.stateIndex,
      simBudget: g.simBudget,
    };
  });
  const p = r.perf, n = Math.max(1, p.frames), wp = r.wp;
  const steps = Math.max(1, wp.granStepN || 1);
  const f = (v) => (v / n).toFixed(2).padStart(7);
  const s = (v) => (v / steps).toFixed(2).padStart(7);
  console.log(`\n=== ${label} — ${p.frames} frames, ${steps} pas de sim, fps=${r.fps.toFixed(1)}, ` +
    `wet=${r.wetCells}, granActive=${r.granActive}, substeps=${r.substeps}, simBudget=${r.simBudget.toFixed(2)} ===`);
  console.log('  ms/frame (moyenne)          ms/pas de sim');
  console.log(`  total     ${f(p.total)}`);
  console.log(`  controls  ${f(p.controls)}   tools ${f(p.tools)}   tools3d ${f(p.tools3d)}  (avatar ${f(wp.avatar)}, particules ${f(wp.particles)})`);
  console.log(`  granular  ${f(p.gran)}   [par pas ${s(wp.granStep)}]`);
  console.log(`  moisture  ${f(p.moist)}   (${wp.moistTickN} ticks, ${(wp.moistTick / Math.max(1, wp.moistTickN)).toFixed(2)} ms/tick, ${r.cols} col/tick, backlog urgent ${r.urgent})`);
  console.log(`  water     ${f(p.water)}   [par pas : scan ${s(wp.scan)}  gen ${s(wp.gen)}  flux ${s(wp.flux)}  integ ${s(wp.integrate)}  break ${s(wp.breaking)}  erode ${s(wp.erode)}  undermine ${s(wp.undermine)}  advect ${s(wp.advect)}  infiltr ${s(wp.infiltrate)}  seep ${s(wp.seep)}]`);
  console.log(`            houle : wavesUpd ${f(wp.wavesUpd)}  buildBands ${f(wp.bands)} (${wp.bandsN}x)`);
  console.log(`  props     ${f(p.props)}   (refresh ${f(wp.propsRefresh)}, ${wp.propsRefreshN}x)`);
  console.log(`  mesh      ${f(p.mesh)}   (file=${r.meshQueue}, worker avg ${r.meshAvgMs.toFixed(1)} ms, ` +
    `${wp.dispatchN} dispatch : extract ${f(wp.extract)}, tri ${f(wp.prioritize)} ; upload terrain ${f(wp.terrainUp)} hors mesure)`);
  console.log(`  waterTex  ${f(p.waterTex)}   (buildRenderLevel ${f(wp.renderLevel)})`);
  console.log(`  render    ${f(p.render)}`);
  console.log(`  hud/divers${f(p.hud)}`);
  return r;
}

// A/B a code identique : les optimisations sont debrayables a chaud.
await phase('AVANT — defaut (petites vagues)', () => {
  window.game.moisture.eco = false;
  window.game.mesher.coolMs = 0;
});
await phase('APRES — defaut (petites vagues)', () => {
  window.game.moisture.eco = true;
  window.game.mesher.coolMs = 600;
});
await phase('AVANT — tempete dechainee', () => {
  window.game.water.setSeaState(5);
  window.game.water.setAgitation(3);
  window.game.moisture.eco = false;
  window.game.mesher.coolMs = 0;
});
await phase('APRES — tempete dechainee', () => {
  window.game.moisture.eco = true;
  window.game.mesher.coolMs = 600;
});

await browser.close();
