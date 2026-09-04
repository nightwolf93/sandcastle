/**
 * Capture d'ecran headless du jeu, pour iterer sur le rendu sans navigateur
 * interactif.
 *
 *   node tools/shot.mjs [nom] [attente_ms] [script_js]
 *
 * Le script optionnel est evalue dans la page apres le chargement (utile pour
 * bouger la camera, changer l'heure, declencher un outil...).
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });

const name = process.argv[2] || 'shot';
const waitMs = Number(process.argv[3] || 9000);
const script = process.argv[4] || '';
const url = process.env.SC_URL || 'http://localhost:5173/?fresh=1';

const browser = await puppeteer.launch({
  headless: 'shell',
  // Le rendu logiciel met parfois plusieurs dizaines de secondes a compiler
  // les shaders : le delai par defaut de 30 s ne suffit pas.
  protocolTimeout: 240000,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

// Attend la fin du chargement (l'ecran de boot disparait) ou le timeout.
try {
  await page.waitForFunction(() => !document.getElementById('boot'), { timeout: waitMs });
} catch {
  logs.push(`[warn] ecran de boot toujours present apres ${waitMs}ms`);
}

await page.evaluate(() => {
  // Rendu logiciel : l'auto-qualite retrograderait. On force le palier haut.
  window.game._qualityProbe = -1;
  window.game.setQuality(2, false);
});
if (script) {
  try {
    const r = await page.evaluate(script);
    if (r !== undefined) logs.push(`[eval] ${JSON.stringify(r)}`);
  } catch (e) {
    logs.push(`[eval-error] ${e.message}`);
  }
}

// Quelques frames pour stabiliser l'amortissement camera / le maillage.
await new Promise((r) => setTimeout(r, 1500));

const stats = await page.evaluate(() => {
  const g = window.game;
  if (!g) return { error: 'pas de game' };
  return {
    fps: Math.round(g.stats.fps),
    sim: +g.stats.sim.toFixed(2),
    triangles: g.stats.triangles,
    meshQueue: g.stats.meshQueue,
    meshed: g.mesher?.stats.meshed,
    avgMeshMs: +(g.mesher?.stats.avgMs || 0).toFixed(2),
    dayT: +g.dayT.toFixed(3),
    glErrors: (() => {
      const gl = g.renderer.getContext();
      return gl.getError();
    })(),
    programs: g.renderer.info.programs?.length,
    calls: g.renderer.info.render.calls,
  };
});

const buf = await page.screenshot({ type: 'png' });
const file = join(OUT, `${name}.png`);
writeFileSync(file, buf);

console.log('--- stats ---');
console.log(JSON.stringify(stats, null, 2));
console.log('--- logs ---');
console.log(logs.slice(-60).join('\n') || '(aucun)');
console.log('--- capture ---');
console.log(file);

await browser.close();
