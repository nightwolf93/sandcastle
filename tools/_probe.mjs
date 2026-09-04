import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 240000,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type()==='error') console.log('[console]', m.text()); });
await page.goto('http://localhost:4173/?fresh=1', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.toolAvatar, { timeout: 30000 });
await page.evaluate(() => { window.game._qualityProbe = -1; window.game.setQuality(0, false); });
// remplir + demouler par l'API (comme test-tools), puis changer d'outil en plein vol
const t0 = Date.now();
await page.evaluate(() => {
  const g = window.game, F = g.field;
  g.tools.select('bucket'); g.tools.setRadius(0.15);
  const t = g.tools.current; t.stuck = false; t.fill = 0;
  const hit = { point: { x: 0.5, y: F.surfaceHeightAt(0.5, 0.5), z: 0.5 }, normal: { x:0,y:1,z:0 } };
  g.tools.hit = hit;
  g.tools.stroke = { button: 0, lockY: null, lastPoint: {...hit.point}, startPoint: {...hit.point}, applied: 1 };
  t.down(g.tools.makeState(hit, 0));
  for (let i = 0; i < 200 && t.fill < 1; i++) {
    const a = i*0.9;
    hit.point.x = 0.5 + Math.cos(a)*0.1; hit.point.z = 0.5 + Math.sin(a)*0.1;
    hit.point.y = F.surfaceHeightAt(hit.point.x, hit.point.z);
    t.apply(g.tools.makeState(hit, 1/30));
  }
  hit.point.x = 1.2; hit.point.z = 0.5; hit.point.y = F.surfaceHeightAt(1.2, 0.5);
  t.up(g.tools.makeState(hit, 0));
  g.tools.endStroke();
});
await new Promise(r => setTimeout(r, 600));
await page.evaluate(() => window.game.tools.select('shovel'));
const done = await page.waitForFunction(() => !window.game.toolAvatar.built.bucket.bucket.busy, { timeout: 30000 }).then(() => true).catch(() => false);
console.log('sequence terminee en arriere-plan:', done, 'en', ((Date.now()-t0)/1000).toFixed(1), 's');
const st = await page.evaluate(() => ({
  stamped: window.game.lastDemould?.stamped, outcome: window.game.lastDemould?.outcome,
  bucketVisible: window.game.toolAvatar.built.bucket.group.visible,
  bg: !!window.game.toolAvatar._bg,
  fps: +window.game.stats.fps.toFixed(1),
}));
console.log(JSON.stringify(st));
await browser.close();
