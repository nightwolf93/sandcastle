/**
 * Capture la scène sous plusieurs angles d'un coup.
 *
 * L'angle rasant est le plus impitoyable : c'est lui qui révèle qu'une nappe
 * d'eau n'a pas d'épaisseur, qu'un bloc n'a pas de tranche, ou qu'une surface
 * moirée. On le regarde donc systématiquement.
 *
 *   node tools/shot-views.mjs [prefixe]
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });
const prefix = process.argv[2] || 'vue';

const VIEWS = [
  // nom,        distance, polar (0 = zenith), azimut,      cible y
  ['rasant',     15.0, 1.42, Math.PI * 0.78, 1.15],
  ['diorama',    15.5, 0.78, Math.PI * 0.78, 1.35],
  ['plongee',    12.0, 0.34, Math.PI * 0.78, 1.30],
  ['rivage',      6.2, 1.24, Math.PI * 0.30, 1.10],
];

/**
 * Le rendu logiciel de Puppeteer echoue parfois a capturer (« Internal
 * error ») quand la frame est lourde. On retente au lieu de tout perdre.
 */
async function shoot(page, path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      writeFileSync(path, await page.screenshot({ type: 'png' }));
      return true;
    } catch (e) {
      if (i === tries - 1) { console.log('  capture impossible : ' + path); return false; }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
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
await page.setViewport({ width: 1500, height: 850 });
const logs = [];
page.on('pageerror', (e) => logs.push('[err] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') logs.push('[console] ' + m.text()); });

console.log('Chargement...');
await page.goto(process.env.SC_URL || 'http://localhost:5173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.tools, { timeout: 30000 });
await page.evaluate(() => {
  const g = window.game;
  g._qualityProbe = -1;
  g.setQuality(2, false);
  g.togglePhotoMode();
  g.controls.autoRotate = false;
});
await new Promise((r) => setTimeout(r, 3500));

for (const [name, dist, polar, az, ty] of VIEWS) {
  await page.evaluate((v) => {
    const c = window.game.controls;
    c.goalDistance = c.distance = v.dist;
    c.goalPolar = c.polar = v.polar;
    c.goalAzimuth = c.azimuth = v.az;
    c.goalTarget.set(0, v.ty, 0);
    c.target.copy(c.goalTarget);
    window.game.controls.autoRotate = false;
  }, { dist, polar, az, ty });
  await new Promise((r) => setTimeout(r, 1600));
  if (await shoot(page, join(OUT, `${prefix}-${name}.png`))) {
    console.log('  shots/' + prefix + '-' + name + '.png');
  }
}

try {
  const stats = await page.evaluate(() => {
    const g = window.game;
    return {
      fps: +g.stats.fps.toFixed(0),
      tris: g.stats.triangles,
      calls: g.renderer.info.render.calls,
      glError: g.renderer.getContext().getError(),
    };
  });
  console.log(JSON.stringify(stats));
} catch (e) {
  console.log('stats indisponibles : ' + e.message);
}
if (logs.length) console.log(logs.slice(0, 8).join('\n'));

await browser.close();
