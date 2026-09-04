/**
 * Interface.
 *
 * Direction : panneaux creme tres arrondis, ombres larges et douces, icones au
 * trait. Rien d'anguleux, aucun chiffre brut.
 *
 * Principe directeur : le joueur ne lit JAMAIS un pourcentage d'humidite. Il
 * lit une couleur, un mot et un conseil. Le panneau "Sable" est un
 * thermometre : le curseur se deplace sur un degrade allant du sable sec au
 * sable liquide, et la zone verte indique la fenetre ou ca tient le mieux.
 */

import { TOOLS, iconPath, DECOR_VARIANTS } from '../tools/tools.js';
import { moistureCategory, packingCategory, thetaMax } from '../sim/SandPhysics.js';
import { AGITATIONS, DAMAGE_LEVELS } from '../sim/Waves.js';
import { WEATHER } from '../core/Weather.js';
import {
  BEACH_STYLES, styleProfilePoints, seedFromText, beachParamsOf, CUSTOM_FIELDS, CUSTOM_FEATURES,
} from '../world/BeachGenerator.js';
import { SEA_LEVEL, NX, NZ, VOXEL, MAP_SIZES } from '../core/Config.js';
import { clamp } from '../core/Config.js';
import { HISTORY_KEEP } from '../core/Save.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function icon(path, size = 26) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.5');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

const cm = (v) => `${Math.round(v * 100)} cm`;

/** Croquis SVG du profil d'un style : la mer en bleu, le sable en ocre. */
function profileSketch(style) {
  const W = 132, Hh = 46;
  const pts = styleProfilePoints(style);
  let dMin = Infinity, dMax = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (const p of pts) { dMin = Math.min(dMin, p.d); dMax = Math.max(dMax, p.d); hMin = Math.min(hMin, p.h); hMax = Math.max(hMax, p.h); }
  hMax = Math.max(hMax, SEA_LEVEL + 0.3); hMin = Math.min(hMin, SEA_LEVEL - 0.5);
  const X = (d) => ((dMax - d) / (dMax - dMin)) * (W - 4) + 2;   // la mer a gauche
  const Y = (h) => Hh - 3 - ((h - hMin) / (hMax - hMin)) * (Hh - 8);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.setAttribute('class', 'beach-sketch');
  const sea = document.createElementNS(SVG_NS, 'rect');
  sea.setAttribute('x', '0'); sea.setAttribute('y', String(Y(SEA_LEVEL)));
  sea.setAttribute('width', String(W)); sea.setAttribute('height', String(Hh - Y(SEA_LEVEL)));
  sea.setAttribute('fill', '#7fd3e3');
  svg.appendChild(sea);
  const sand = document.createElementNS(SVG_NS, 'path');
  let d = `M${X(pts[0].d)} ${Hh}`;
  for (const p of pts) d += ` L${X(p.d).toFixed(1)} ${Y(p.h).toFixed(1)}`;
  d += ` L${X(pts[pts.length - 1].d)} ${Hh} Z`;
  sand.setAttribute('d', d);
  sand.setAttribute('fill', '#e6c98f');
  sand.setAttribute('stroke', '#a8814f');
  sand.setAttribute('stroke-width', '1');
  svg.appendChild(sand);
  return svg;
}

/** « il y a 3 min », puis la date et l'heure au-dela d'une heure. */
function formatWhen(date, now = Date.now()) {
  if (!date) return 'ancienne';
  const s = Math.max(0, (now - date) / 1000);
  if (s < 60) return 'à l instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  const d = new Date(date);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `aujourd hui ${time}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** Petites icones d'interface (pas des outils). */
const UI_ICONS = {
  mirror: 'M12 3 L12 21 M4 8 L10 12 L4 16 Z M20 8 L14 12 L20 16 Z',
  sun: 'M12 5.4 A6.6 6.6 0 1 0 12 18.6 A6.6 6.6 0 1 0 12 5.4 M12 1.4 L12 3 M12 21 L12 22.6 M22.6 12 L21 12 M3 12 L1.4 12 M19.5 4.5 L18.4 5.6 M5.6 18.4 L4.5 19.5 M19.5 19.5 L18.4 18.4 M5.6 5.6 L4.5 4.5',
  tide: 'M2.4 15.4 C5 13 7 17.8 9.6 15.4 C12.2 13 14.2 17.8 16.8 15.4 C19 13.4 20.6 15.8 21.6 15.4 M2.4 19.4 C5 17 7 21.8 9.6 19.4 C12.2 17 14.2 21.8 16.8 19.4 C19 17.4 20.6 19.8 21.6 19.4 M12 3 L12 10 M9 6.6 L12 3.4 L15 6.6',
  camera: 'M3.4 8.6 A2 2 0 0 1 5.4 6.6 L8 6.6 L9.4 4.2 L14.6 4.2 L16 6.6 L18.6 6.6 A2 2 0 0 1 20.6 8.6 L20.6 17.6 A2 2 0 0 1 18.6 19.6 L5.4 19.6 A2 2 0 0 1 3.4 17.6 Z M12 8.8 A4 4 0 1 0 12 16.8 A4 4 0 1 0 12 8.8',
  sound: 'M4.4 9.4 L8 9.4 L12.6 5.2 L12.6 18.8 L8 14.6 L4.4 14.6 Z M15.8 9 A4.2 4.2 0 0 1 15.8 15 M18.4 6.4 A7.8 7.8 0 0 1 18.4 17.6',
  mute: 'M4.4 9.4 L8 9.4 L12.6 5.2 L12.6 18.8 L8 14.6 L4.4 14.6 Z M16 9.6 L21 14.6 M21 9.6 L16 14.6',
  help: 'M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 M9.4 9.4 A2.7 2.7 0 0 1 14.6 10.4 C14.6 12.4 12 12.6 12 14.6 M12 17.6 L12 17.8',
  save: 'M4.4 6.4 A2 2 0 0 1 6.4 4.4 L15.6 4.4 L19.6 8.4 L19.6 17.6 A2 2 0 0 1 17.6 19.6 L6.4 19.6 A2 2 0 0 1 4.4 17.6 Z M8 4.4 L8 9.6 L15 9.6 L15 4.4 M7.4 13.4 L16.6 13.4 M7.4 16.4 L16.6 16.4',
  newBeach: 'M3 18.6 C6 15.6 9 21 12 18 C15 15 18 20.4 21 18 M4.6 12.6 A7.4 7.4 0 0 1 19.4 12.6 M12 5.2 L12 12.6 M9 8.2 L12 5.2 L15 8.2',
  undo: 'M4 9.6 L4 4.6 M4 9.6 L9 9.6 M4.6 9 A8 8 0 1 1 5.4 16.4',
  reset: 'M20 9.6 L20 4.6 M20 9.6 L15 9.6 M19.4 9 A8 8 0 1 0 18.6 16.4',
  quality: 'M4 19.6 L7.4 19.6 L7.4 13.6 L4 13.6 Z M10.3 19.6 L13.7 19.6 L13.7 9.4 L10.3 9.4 Z M16.6 19.6 L20 19.6 L20 4.4 L16.6 4.4 Z',
  sea: 'M2.4 9.4 C5 7 7 11.8 9.6 9.4 C12.2 7 14.2 11.8 16.8 9.4 C19 7.4 20.6 9.8 21.6 9.4 M2.4 14.4 C5 12 7 16.8 9.6 14.4 C12.2 12 14.2 16.8 16.8 14.4 C19 12.4 20.6 14.8 21.6 14.4 M2.4 19.4 C5 17 7 21.8 9.6 19.4 C12.2 17 14.2 21.8 16.8 19.4 C19 17.4 20.6 19.8 21.6 19.4 M15.4 3.2 A2.2 2.2 0 1 0 15.4 7.6 A2.2 2.2 0 1 0 15.4 3.2',
  shell: 'M12 3.4 C6.6 3.4 3 8.4 3 13 C3 17 6 20.6 12 20.6 C18 20.6 21 17 21 13 C21 8.4 17.4 3.4 12 3.4 M12 3.6 L12 20.4 M8.4 4.6 L6 19.4 M15.6 4.6 L18 19.4 M5 7.6 L3.6 16.6 M19 7.6 L20.4 16.6',
};

export class HUD {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.hidden = false;
    this.toasts = [];
    this.build();
    this.bind();
  }

  // -------------------------------------------------------------------------
  build() {
    const r = this.root;
    r.innerHTML = '';

    // --- badge de lieu -----------------------------------------------------
    const place = el('div', 'place-badge', r);
    const pin = document.createElementNS(SVG_NS, 'svg');
    pin.setAttribute('viewBox', '0 0 24 24');
    pin.setAttribute('width', '16'); pin.setAttribute('height', '16');
    const pp = document.createElementNS(SVG_NS, 'path');
    pp.setAttribute('d', 'M12 2.6 A6.4 6.4 0 0 1 18.4 9 C18.4 13.6 12 21.4 12 21.4 C12 21.4 5.6 13.6 5.6 9 A6.4 6.4 0 0 1 12 2.6 M12 6.8 A2.2 2.2 0 1 0 12 11.2 A2.2 2.2 0 1 0 12 6.8');
    pp.setAttribute('fill', 'none'); pp.setAttribute('stroke', 'currentColor');
    pp.setAttribute('stroke-width', '1.6'); pp.setAttribute('stroke-linejoin', 'round');
    pin.appendChild(pp);
    place.appendChild(pin);
    this.placeName = el('span', 'place-name', place);
    this.placeName.textContent = 'Crique des Oyats';
    this.tideChip = el('span', 'tide-chip', place);

    // --- boutons ronds en haut a droite ------------------------------------
    const tr = el('div', 'top-right', r);
    this.btnTime = this.roundButton(tr, UI_ICONS.sun, 'Heure du jour', () => this.cycleTime());
    this.btnTide = this.roundButton(tr, UI_ICONS.tide, 'Vitesse de la maree', () => this.cycleTide());
    this.btnSea = this.roundButton(tr, UI_ICONS.sea, 'Mer : vagues, agitation, erosion', () => this.toggleSeaPanel());
    this.btnSound = this.roundButton(tr, UI_ICONS.sound, 'Son', () => this.toggleSound());
    this.btnQuality = this.roundButton(tr, UI_ICONS.quality, 'Qualite graphique',
      () => this.game.setQuality((this.game.quality + 1) % 3));
    this.btnSave = this.roundButton(tr, UI_ICONS.save, 'Sauvegardes et reglages (Ctrl+S : sauvegarder)', () => this.toggleSavePanel());
    this.btnNew = this.roundButton(tr, UI_ICONS.newBeach, 'Nouvelle plage', () => this.toggleBeachPanel());
    this.btnPhoto = this.roundButton(tr, UI_ICONS.camera, 'Mode photo (P)', () => this.game.togglePhotoMode());
    this.btnHelp = this.roundButton(tr, UI_ICONS.help, 'Aide (H)', () => this.toggleHelp());

    // --- panneau Sable (gauche) --------------------------------------------
    const sand = el('div', 'panel sand-panel', r);
    el('div', 'panel-title', sand).textContent = 'Sable';

    const gauge = el('div', 'moist-gauge', sand);
    el('div', 'moist-track', gauge);
    this.moistSweet = el('div', 'moist-sweet', gauge);
    this.moistMarker = el('div', 'moist-marker', gauge);
    const labels = el('div', 'moist-labels', sand);
    el('span', null, labels).textContent = 'sec';
    el('span', null, labels).textContent = 'parfait';
    el('span', null, labels).textContent = 'liquide';

    this.moistState = el('div', 'sand-state', sand);
    this.moistSwatch = el('div', 'sand-swatch', this.moistState);
    const st = el('div', 'sand-text', this.moistState);
    this.moistLabel = el('div', 'sand-label', st);
    this.moistHint = el('div', 'sand-hint', st);

    const rows = el('div', 'sand-rows', sand);
    this.rowPack = this.statRow(rows, 'Compaction', '#c79a5e');
    this.rowHold = this.statRow(rows, 'Tenue', '#7bbf6a');
    this.rowWater = this.statRow(rows, 'Eau', '#5fa8d8');

    // --- panneau Mer (droite, sous les boutons) -----------------------------
    // La meteo d'un geste, puis chaque jauge a la main : hauteur et puissance
    // des vagues, agitation, et ce que la mer abime. Tout est sauvegarde
    // avec la partie.
    this.seaPanel = el('div', 'panel sea-panel', r);
    this.seaPanel.style.display = 'none';
    el('div', 'panel-title', this.seaPanel).textContent = 'Mer et meteo';
    const weatherModes = el('div', 'builder-modes weather-modes', this.seaPanel);
    this.weatherButtons = WEATHER.map((w, i) => {
      const b = el('button', 'builder-mode', weatherModes);
      b.textContent = w.label;
      b.title = w.sub;
      b.addEventListener('click', () => {
        this.game.weather.apply(i);
        this.syncSeaPanel();
        this.game.toast(w.label + ' — ' + w.sub);
        this.game.audio?.play('ui');
      });
      return b;
    });
    this.weatherTip = el('div', 'builder-tip sea-tip', this.seaPanel);
    const seaRows = el('div', 'builder-section', this.seaPanel);
    const custom = () => this.game.weather.markCustom();
    this.seaControls = {
      height: this.seaRange(seaRows, 'Hauteur', 0, 80, 1,
        (v) => { this.game.water.setWaveHeight(v / 100); custom(); },
        (v) => ({ label: `${v} cm`, sub: v > 50
          ? 'Plus haut que l eau du large ne le permet : la vague casse des le large, en ressaut.'
          : 'Hauteur des vagues au large. Au-dela de 30 cm, prevoyez une douve.' })),
      power: this.seaRange(seaRows, 'Puissance', 0, 100, 5,
        (v) => { this.game.water.setWavePower(v / 100); custom(); },
        (v) => ({ label: `${v} %`, sub: 'Des vagues longues qui deferlent en plongeant, projettent des embruns et courent loin sur le sable.' })),
      agit: this.seaRange(seaRows, 'Agitation', 0, AGITATIONS.length - 1, 1,
        (i) => { this.game.water.setAgitation(i); custom(); }, (i) => AGITATIONS[i]),
      damage: this.seaRange(seaRows, 'Erosion', 0, DAMAGE_LEVELS.length - 1, 1,
        (i) => this.game.water.setDamage(i), (i) => DAMAGE_LEVELS[i]),
    };
    this.syncSeaPanel();

    // --- panneau Sauvegardes et reglages (droite, sous les boutons) ---------
    this.savePanel = el('div', 'panel sea-panel save-panel', r);
    this.savePanel.style.display = 'none';
    el('div', 'panel-title', this.savePanel).textContent = 'Sauvegardes et réglages';
    const saveRows = el('div', 'builder-section', this.savePanel);
    this.autosaveToggle = this.toggleRow(saveRows, 'Sauvegarde automatique', (on) => {
      this.game.save.setAutosave(on);
      this.syncSavePanel();
      this.game.toast(on ? 'Sauvegarde automatique activée' : 'Sauvegarde automatique désactivée');
    });
    this.autosaveStatus = el('div', 'builder-tip sea-tip', saveRows);
    this.sandSafeToggle = this.toggleRow(saveRows, 'L eau n emporte pas le sable', (on) => {
      this.game.setSandSafe(on);
      this.syncSavePanel();
      this.game.toast(on ? 'La mer ne creuse plus rien' : 'La mer érode à nouveau');
    });
    const safeTip = el('div', 'builder-tip sea-tip', saveRows);
    safeTip.textContent = 'Pour sculpter sans craindre la mer : ni érosion ni sape, quel que soit le niveau d érosion du panneau Mer. Conservé d une partie à l autre.';
    const saveNow = el('button', 'builder-mode active save-now', saveRows);
    saveNow.textContent = 'Sauvegarder maintenant';
    saveNow.addEventListener('click', () => this.game.saveNow('manual'));
    el('div', 'save-history-title', this.savePanel).textContent = 'Historique';
    this.saveList = el('div', 'save-history', this.savePanel);
    this._saveTick = 0;

    // --- generateur de sable (droite, visible seulement avec B) ------------
    this.builderPanel = el('div', 'panel builder-panel', r);
    el('div', 'panel-title', this.builderPanel).textContent = 'Construire en sable';
    const modes = el('div', 'builder-modes', this.builderPanel);
    this.builderModeBlock = el('button', 'builder-mode', modes);
    this.builderModeBlock.textContent = 'Bloc';
    this.builderModeBlock.addEventListener('click', () => this.game.tools.setSandMode('block'));
    this.builderModeWall = el('button', 'builder-mode', modes);
    this.builderModeWall.textContent = 'Mur spline';
    this.builderModeWall.addEventListener('click', () => this.game.tools.setSandMode('wall'));
    this.builderModeTower = el('button', 'builder-mode', modes);
    this.builderModeTower.textContent = 'Tour';
    this.builderModeTower.addEventListener('click', () => this.game.tools.setSandMode('tower'));
    this.builderModeDome = el('button', 'builder-mode', modes);
    this.builderModeDome.textContent = 'Dôme';
    this.builderModeDome.addEventListener('click', () => this.game.tools.setSandMode('dome'));

    this.builderControls = [];
    this.builderBlock = el('div', 'builder-section', this.builderPanel);
    this.builderRange(this.builderBlock, 'Largeur', 'blockWidth', 0.12, 1.60, 0.02, cm);
    this.builderRange(this.builderBlock, 'Longueur', 'blockLength', 0.12, 2.40, 0.02, cm);
    this.builderRange(this.builderBlock, 'Hauteur', 'height', 0.08, 1.40, 0.02, cm);
    this.builderRange(this.builderBlock, 'Rotation', 'rotation', -Math.PI, Math.PI,
      Math.PI / 36, (v) => `${Math.round(v * 180 / Math.PI)}°`);
    const blockTip = el('div', 'builder-tip', this.builderBlock);
    blockTip.textContent = 'Ajuste la forme dans l aperçu, puis clique pour la poser.';

    this.builderWall = el('div', 'builder-section', this.builderPanel);
    this.builderRange(this.builderWall, 'Epaisseur', 'wallWidth', 0.08, 0.80, 0.02, cm);
    this.builderRange(this.builderWall, 'Hauteur', 'wallHeight', 0.10, 1.40, 0.02, cm);
    this.builderRange(this.builderWall, 'Lissage', 'smoothness', 0, 1, 0.02,
      (v) => `${Math.round(v * 100)} %`);

    const crenelToggle = el('label', 'builder-toggle', this.builderWall);
    this.builderCrenels = el('input', null, crenelToggle);
    this.builderCrenels.type = 'checkbox';
    el('span', 'builder-check', crenelToggle);
    el('span', null, crenelToggle).textContent = 'Créneaux sur le mur';
    this.builderCrenels.addEventListener('change', () => {
      this.game.tools.setSandSetting('crenels', this.builderCrenels.checked);
      this.syncBuilderPanel(this.game.tools.current);
    });
    this.builderCrenelControls = el('div', 'builder-crenel-controls', this.builderWall);
    this.builderRange(this.builderCrenelControls, 'Taille', 'crenelWidth', 0.08, 0.48, 0.02, cm);
    this.builderRange(this.builderCrenelControls, 'Hauteur', 'crenelHeight', 0.06, 0.42, 0.02, cm);
    const wallTip = el('div', 'builder-tip', this.builderWall);
    wallTip.textContent = 'Maintiens le clic et dessine. Maj force un mur parfaitement droit.';

    this.builderTower = el('div', 'builder-section', this.builderPanel);
    this.builderRange(this.builderTower, 'Rayon', 'towerRadius', 0.05, 0.60, 0.01, cm);
    this.builderRange(this.builderTower, 'Hauteur', 'towerHeight', 0.08, 1.40, 0.02, cm);
    this.builderRange(this.builderTower, 'Fruit', 'towerTaper', 0, 0.6, 0.02, (v) => `${Math.round(v * 100)} %`);
    const roofToggle = el('label', 'builder-toggle', this.builderTower);
    this.builderRoof = el('input', null, roofToggle);
    this.builderRoof.type = 'checkbox';
    el('span', 'builder-check', roofToggle);
    el('span', null, roofToggle).textContent = 'Toit conique';
    this.builderRoof.addEventListener('change', () => {
      this.game.tools.setSandSetting('roof', this.builderRoof.checked);
      this.syncBuilderPanel(this.game.tools.current);
    });
    this.builderRoofControls = el('div', 'builder-crenel-controls', this.builderTower);
    this.builderRange(this.builderRoofControls, 'Toit', 'roofHeight', 0.04, 0.60, 0.02, cm);
    const towerTip = el('div', 'builder-tip', this.builderTower);
    towerTip.textContent = 'Le fruit resserre la tour vers le haut : c est ce qui la fait tenir sous la houle.';

    this.builderDome = el('div', 'builder-section', this.builderPanel);
    this.builderRange(this.builderDome, 'Rayon', 'domeRadius', 0.05, 0.80, 0.01, cm);
    this.builderRange(this.builderDome, 'Hauteur', 'domeHeight', 0.03, 0.60, 0.01, cm);
    const domeTip = el('div', 'builder-tip', this.builderDome);
    domeTip.textContent = 'Un dôme bas fait une dune, un dôme haut une coupole.';

    // --- main : intensite du lissage (droite, visible avec l'outil 2) -------
    this.handPanel = el('div', 'panel builder-panel hand-panel', r);
    el('div', 'panel-title', this.handPanel).textContent = 'Main';
    const handRows = el('div', 'builder-section', this.handPanel);
    this.handControl = this.seaRange(handRows, 'Intensité', 0, 100, 5,
      (v) => this.game.tools.setToolSetting('hand', 'intensity', v / 100),
      (v) => ({ label: `${v} %`, sub: v < 30
        ? 'Polissage : efface le grain de la grille, garde les arêtes.'
        : v < 70
          ? 'Arrondit les bords et fond les marches en pentes.'
          : 'Fond tout : une falaise devient une dune, les murs fins s effacent.' }));
    const handTip = el('div', 'builder-tip', this.handPanel);
    handTip.textContent = 'Ctrl + Maj + molette règle aussi l intensité.';

    // --- badge ressource (bas gauche) --------------------------------------
    const res = el('div', 'resource-badge', r);
    const shell = icon(UI_ICONS.shell, 26);
    shell.classList.add('res-icon');
    res.appendChild(shell);
    this.resText = el('span', 'res-text', res);
    this.resText.textContent = 'Pelle vide';

    // --- infobulle d'outil (au-dessus de la barre) -------------------------
    this.toolInfo = el('div', 'tool-info', r);
    this.toolInfoName = el('span', 'ti-name', this.toolInfo);
    this.toolInfoHint = el('span', 'ti-hint', this.toolInfo);
    this.toolInfoSize = el('span', 'ti-size', this.toolInfo);

    // --- barre d'outils ----------------------------------------------------
    const bar = el('div', 'toolbar', r);
    this.toolButtons = TOOLS.map((t, i) => {
      const b = el('button', 'tool-btn', bar);
      b.appendChild(icon(iconPath(t.icon), 28));
      b.title = `${t.name} — ${t.hint}`;
      b.dataset.id = t.id;
      b.addEventListener('click', () => {
        this.game.tools.select(t.id);
        this.game.audio?.play('ui');
      });
      const k = el('span', 'tool-key', b);
      // L'etiquette vient de la touche, pas de la position dans la barre :
      // un outil a lettre insere au milieu ne decale pas les chiffres.
      k.textContent = t.keyLabel
        || (t.key?.startsWith('Digit') ? t.key.slice(5) : String((i + 1) % 10));
      return b;
    });
    el('div', 'toolbar-sep', bar);
    this.btnUndo = el('button', 'tool-btn small', bar);
    this.btnUndo.appendChild(icon(UI_ICONS.undo, 22));
    this.btnUndo.title = 'Annuler (Ctrl+Z)';
    this.btnUndo.addEventListener('click', () => {
      // Meme chemin que Ctrl+Z : reveil granulaire compris, et aucun
      // remaillage force quand il n'y a rien a annuler.
      const l = this.game.tools.doUndo();
      this.game.toast(l ? 'Annule : ' + l : 'Rien a annuler');
    });

    this.btnMirror = el('button', 'tool-btn small', bar);
    this.btnMirror.appendChild(icon(UI_ICONS.mirror, 22));
    this.btnMirror.title = 'Miroir (M) — Maj+M : autre axe';
    this.btnMirror.addEventListener('click', () => this.game.tools.toggleMirror(false));

    // --- panneau de reglages d'outil (droite) --------------------------------
    // Un seul panneau, reconstruit quand l'outil change, pilote par la
    // description `panel` de l'outil : groupes de modes et jauges.
    this.toolPanel = el('div', 'panel builder-panel tool-panel', r);
    this.toolPanel.style.display = 'none';
    this._toolPanelFor = null;
    this._toolPanelControls = [];

    // --- nouvelle plage : style et graine ------------------------------------
    // Un vrai choix, pas un des : chaque style a son croquis de profil, et la
    // graine se lit, se tape (un mot suffit) et se partage.
    this.beachPanel = el('div', 'help-panel beach-panel', r);
    this.beachPanel.style.display = 'none';
    this.beachPanel.addEventListener('click', (e) => { if (e.target === this.beachPanel) this.toggleBeachPanel(false); });
    const bcard = el('div', 'help-card beach-card', this.beachPanel);
    el('h2', null, bcard).textContent = 'Nouvelle plage';
    this.beachCurrent = el('p', 'beach-current', bcard);
    const grid = el('div', 'beach-grid', bcard);
    this.beachChoice = 'classique';
    this.beachCards = BEACH_STYLES.map((st) => {
      const b = el('button', 'beach-style', grid);
      b.dataset.id = st.id;
      b.appendChild(profileSketch(st));
      el('div', 'beach-name', b).textContent = st.name;
      el('div', 'beach-blurb', b).textContent = st.blurb;
      b.addEventListener('click', () => {
        this.beachChoice = st.id;
        // Le gabarit remplit les jauges ; ce qui a ete retouche est remplace.
        this.beachParams = beachParamsOf(st.id);
        this.syncCustomControls();
        this.syncBeachPanel();
        this.game.audio?.play('ui');
      });
      return b;
    });
    // --- taille de la carte -------------------------------------------------
    const sizeRow = el('div', 'beach-size', bcard);
    el('span', 'beach-seed-label', sizeRow).textContent = 'Carte';
    const mkSize = (current) => {
      const sel = el('select', 'beach-select', sizeRow);
      for (const n of MAP_SIZES) {
        const o = el('option', null, sel);
        o.value = String(n);
        o.textContent = `${(n * VOXEL).toFixed(1).replace('.', ',')} m`;
        if (n === current) o.selected = true;
      }
      return sel;
    };
    this.beachSizeX = mkSize(NX);
    el('span', 'beach-times', sizeRow).textContent = 'x';
    this.beachSizeZ = mkSize(NZ);
    this.beachSizeNote = el('span', 'beach-size-note', sizeRow);
    const noteSize = () => {
      const nx = Number(this.beachSizeX.value), nz = Number(this.beachSizeZ.value);
      this.beachSizeNote.textContent = nx !== NX || nz !== NZ
        ? 'Changer la taille recharge la page.'
        : 'Largeur x longueur (la mer est sur la longueur).';
      this.syncCustomBounds();
    };
    this.beachSizeX.addEventListener('change', noteSize);
    this.beachSizeZ.addEventListener('change', noteSize);
    noteSize();

    // --- personnalisation du profil ----------------------------------------
    // Un gabarit (carte ci-dessus) remplit ces jauges ; chacune se retouche
    // et le croquis suit. Tout est physique : metres et centimetres.
    this.beachParams = beachParamsOf('classique');
    const customBox = el('details', 'beach-custom', bcard);
    el('summary', null, customBox).textContent = 'Personnaliser le profil';
    const customBody = el('div', 'beach-custom-body', customBox);
    this.customSketch = profileSketch(this.beachParams);
    this.customSketch.classList.add('beach-sketch-big');
    customBody.appendChild(this.customSketch);
    const customRows = el('div', 'builder-section', customBody);
    this.customControls = [];
    const fmtOf = {
      m: (v) => `${v.toFixed(1).replace('.', ',')} m`,
      cm: (v) => `${Math.round(v * 100)} cm`,
      mm: (v) => `${Math.round(v * 1000)} mm`,
      pct: (v) => `${(v * 100).toFixed(1).replace('.', ',')} %`,
      x: (v) => `x ${v.toFixed(2).replace('.', ',')}`,
    };
    for (const f of CUSTOM_FIELDS) {
      const row = el('label', 'builder-row', customRows);
      el('span', 'builder-label', row).textContent = f.label;
      const input = el('input', 'builder-range', row);
      input.type = 'range'; input.step = f.step;
      const value = el('span', 'builder-value', row);
      const format = fmtOf[f.format] || String;
      if (f.tip) row.title = f.tip;
      input.addEventListener('input', () => {
        this.beachParams[f.key] = Number(input.value);
        value.textContent = format(this.beachParams[f.key]);
        this.refreshCustomSketch();
      });
      this.customControls.push({ field: f, input, value, format });
    }
    this.customFeatures = [];
    for (const feat of CUSTOM_FEATURES) {
      const row = el('label', 'builder-toggle', customRows);
      const input = el('input', null, row);
      input.type = 'checkbox';
      el('span', 'builder-check', row);
      el('span', null, row).textContent = feat.label;
      input.addEventListener('change', () => {
        const P = this.beachParams;
        if (feat.key === 'cliff') P.cliff = input.checked ? feat.make(P) : null;
        else if (input.checked) {
          P.bar = feat.make(P);
          // Banc et recif s'excluent : un seul relief au large.
          for (const other of this.customFeatures) if (other.feat.key !== feat.key && other.feat.key !== 'cliff') other.input.checked = false;
        } else if (feat.test(P)) P.bar = null;
        this.refreshCustomSketch();
      });
      this.customFeatures.push({ feat, input });
    }
    this.syncCustomControls();

    const seedRow = el('div', 'beach-seed', bcard);
    el('span', 'beach-seed-label', seedRow).textContent = 'Graine';
    this.beachSeed = el('input', 'beach-seed-input', seedRow);
    this.beachSeed.type = 'text';
    this.beachSeed.placeholder = 'un nombre ou un mot';
    this.beachSeed.spellcheck = false;
    const dice = el('button', 'builder-mode beach-dice', seedRow);
    dice.textContent = 'Au hasard';
    dice.addEventListener('click', () => { this.beachSeed.value = String((Math.random() * 1e9) | 0); this.game.audio?.play('ui'); });
    el('p', 'beach-tip', bcard).textContent = 'Le meme style et la meme graine redonnent exactement la meme plage : notez-la pour la partager.';
    const actions = el('div', 'beach-actions', bcard);
    const keep = el('button', 'builder-mode', actions);
    keep.textContent = 'Garder ma plage';
    keep.addEventListener('click', () => this.toggleBeachPanel(false));
    const gen = el('button', 'builder-mode active beach-generate', actions);
    gen.textContent = 'Generer (efface la plage actuelle)';
    gen.addEventListener('click', () => {
      const seed = seedFromText(this.beachSeed.value);
      const params = { ...this.beachParams, id: this.beachChoice, nx: Number(this.beachSizeX.value), nz: Number(this.beachSizeZ.value) };
      this.toggleBeachPanel(false);
      this.game.newBeach(params, seed);
    });

    // --- toasts ------------------------------------------------------------
    this.toastBox = el('div', 'toast-box', r);

    // --- aide --------------------------------------------------------------
    this.help = el('div', 'help-panel', r);
    this.help.innerHTML = HELP_HTML;
    this.help.style.display = 'none';
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.toggleHelp();
    });

    // --- diagnostics (F3) --------------------------------------------------
    this.debug = el('div', 'debug-panel', r);
    this.debug.style.display = 'none';
    this.debugStats = el('pre', 'debug-stats', this.debug);

    this.setActiveTool(this.game.tools?.current);
  }

  roundButton(parent, path, title, onClick) {
    const b = el('button', 'round-btn', parent);
    b.appendChild(icon(path, 21));
    b.title = title;
    b.addEventListener('click', () => { onClick(); this.game.audio?.play('ui'); });
    return b;
  }

  statRow(parent, label, color) {
    const row = el('div', 'stat-row', parent);
    el('span', 'stat-label', row).textContent = label;
    const track = el('div', 'stat-track', row);
    const bar = el('div', 'stat-bar', track);
    bar.style.background = color;
    const val = el('span', 'stat-val', row);
    return { row, bar, val };
  }

  /**
   * Une jauge du panneau Mer : un curseur a crans, l'etiquette du cran, et
   * une ligne d'explication. `describe(i)` rend { label, sub }.
   */
  seaRange(parent, label, min, max, step, apply, describe) {
    const row = el('label', 'builder-row', parent);
    el('span', 'builder-label', row).textContent = label;
    const input = el('input', 'builder-range', row);
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    const value = el('span', 'builder-value', row);
    const tip = el('div', 'builder-tip sea-tip', parent);
    const show = (i) => {
      const d = describe(i);
      value.textContent = d.label;
      tip.textContent = d.sub;
    };
    input.addEventListener('input', () => {
      const i = Number(input.value);
      apply(i);
      show(i);
      this.game.audio?.play('ui');
    });
    return { input, show, tip, row };
  }

  /** Recale les jauges sur l'etat courant (chargement, nouvelle plage). */
  syncSeaPanel() {
    const w = this.game.water;
    if (!w || !this.seaControls) return;
    const set = (ctl, v) => { ctl.input.value = String(v); ctl.show(v); };
    set(this.seaControls.height, Math.round(w.waves.hs * 100));
    set(this.seaControls.power, Math.round(w.waves.power * 20) * 5);
    set(this.seaControls.agit, w.waves.agitIndex);
    set(this.seaControls.damage, w.damageIndex);
    // « L'eau n'emporte pas le sable » neutralise la jauge : on le dit ici,
    // la ou le joueur viendrait chercher pourquoi la mer ne creuse plus.
    const safe = !!this.game.sandSafe;
    const dmg = this.seaControls.damage;
    dmg.row.classList.toggle('disabled', safe);
    if (safe) dmg.tip.textContent = 'Sans effet : « L eau n emporte pas le sable » est actif (bouton disquette, réglages).';
    const wi = this.game.weather?.index ?? -1;
    this.weatherButtons?.forEach((b, i) => b.classList.toggle('active', i === wi));
    if (this.weatherTip) {
      this.weatherTip.textContent = wi >= 0 ? WEATHER[wi].sub : 'Reglage personnalise.';
    }
  }

  toggleSeaPanel(force = null) {
    const open = force == null ? this.seaPanel.style.display === 'none' : !!force;
    this.seaPanel.style.display = open ? 'block' : 'none';
    this.btnSea.classList.toggle('active', open);
    if (open) {
      this.syncSeaPanel();
      this.builderPanel.style.display = 'none';
      this.toggleSavePanel(false);
    }
  }

  /** Une ligne interrupteur : etiquette + bascule. Retourne l'input. */
  toggleRow(parent, label, onChange) {
    const row = el('label', 'builder-toggle', parent);
    const input = el('input', null, row);
    input.type = 'checkbox';
    el('span', 'builder-check', row);
    el('span', null, row).textContent = label;
    input.addEventListener('change', () => {
      onChange(input.checked);
      this.game.audio?.play('ui');
    });
    return input;
  }

  toggleSavePanel(force = null) {
    const open = force == null ? this.savePanel.style.display === 'none' : !!force;
    this.savePanel.style.display = open ? 'block' : 'none';
    this.btnSave.classList.toggle('active', open);
    if (open) {
      this.toggleSeaPanel(false);
      this.builderPanel.style.display = 'none';
      this.syncSavePanel();
      this.refreshSaveList();
    }
  }

  /** Recale les interrupteurs et le texte d'etat sur l'etat courant. */
  syncSavePanel() {
    const sv = this.game.save;
    this.autosaveToggle.checked = !!sv.autosaveEnabled;
    this.sandSafeToggle.checked = !!this.game.sandSafe;
    if (sv.autosaveEnabled) {
      const next = Math.ceil(sv.nextAutosaveIn);
      this.autosaveStatus.textContent =
        `Toutes les ${sv.autosaveEvery} s (prochaine dans ${next} s). Les ${HISTORY_KEEP.auto} dernières automatiques et ${HISTORY_KEEP.manual} manuelles sont conservées.`;
    } else {
      this.autosaveStatus.textContent =
        'Désactivée. Seules vos sauvegardes manuelles (Ctrl+S) comptent, y compris pour la reprise au démarrage.';
    }
  }

  /** L'historique a change (sauvegarde, chargement) : on le redessine s'il est visible. */
  onSavesChanged() {
    if (this.savePanel.style.display !== 'none') this.refreshSaveList();
  }

  async refreshSaveList() {
    let entries = [];
    try { entries = await this.game.save.list(); } catch { entries = []; }
    const list = this.saveList;
    list.textContent = '';
    if (!entries.length) {
      el('div', 'save-empty', list).textContent = 'Aucune sauvegarde pour l instant.';
      return;
    }
    const now = Date.now();
    for (const e of entries) {
      const row = el('div', 'save-row', list);
      el('span', 'save-when', row).textContent = formatWhen(e.date, now);
      el('span', 'save-kind', row).textContent = e.kind === 'auto' ? 'auto' : 'manuelle';
      const loadBtn = el('button', 'save-load', row);
      loadBtn.textContent = 'Charger';
      // Charger ecrase l'etat courant : deux clics, comme la nouvelle plage.
      this.armConfirm(loadBtn, 'Charger', 'Confirmer ?', () => this.game.loadLast(e.key));
      const delBtn = el('button', 'save-del', row);
      delBtn.textContent = '×';
      delBtn.title = 'Supprimer cette sauvegarde';
      this.armConfirm(delBtn, '×', 'Sûr ?', async () => {
        await this.game.save.remove(e.key).catch(() => {});
        this.refreshSaveList();
      });
    }
  }

  /** Bouton a confirmation : premier clic arme (4 s), second execute. */
  armConfirm(btn, label, armedLabel, action) {
    let timer = null;
    btn.addEventListener('click', () => {
      if (timer) {
        clearTimeout(timer); timer = null;
        btn.classList.remove('warn'); btn.textContent = label;
        action();
        return;
      }
      btn.classList.add('warn'); btn.textContent = armedLabel;
      timer = setTimeout(() => {
        timer = null;
        btn.classList.remove('warn'); btn.textContent = label;
      }, 4000);
    });
  }

  builderRange(parent, label, key, min, max, step, format) {
    const row = el('label', 'builder-row', parent);
    el('span', 'builder-label', row).textContent = label;
    const input = el('input', 'builder-range', row);
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    const value = el('span', 'builder-value', row);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = format(v);
      this.game.tools.setSandSetting(key, v);
    });
    this.builderControls.push({ key, input, value, format });
    return input;
  }

  bind() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyH') this.toggleHelp();
      if (e.code === 'F3') { e.preventDefault(); this.toggleDebug(); }
      if (e.code === 'Escape' && this.help.style.display !== 'none') this.toggleHelp();
      else if (e.code === 'Escape' && this.seaPanel.style.display !== 'none') this.toggleSeaPanel(false);
      else if (e.code === 'Escape' && this.savePanel.style.display !== 'none') this.toggleSavePanel(false);
      else if (e.code === 'Escape' && this.beachPanel.style.display !== 'none') this.toggleBeachPanel(false);
    });
  }

  // -------------------------------------------------------------------------
  // ACTIONS
  // -------------------------------------------------------------------------

  cycleTime() {
    const g = this.game;
    const steps = [0.27, 0.36, 0.5, 0.66, 0.76, 0.86];
    const names = ['Lever du jour', 'Matin', 'Midi', 'Apres-midi', 'Heure doree', 'Nuit'];
    let i = 0;
    let best = 9;
    for (let k = 0; k < steps.length; k++) {
      const d = Math.abs(((steps[k] - g.dayT + 1.5) % 1) - 0.5);
      if (d < best) { best = d; i = k; }
    }
    i = (i + 1) % steps.length;
    g.dayT = steps[i];
    g.sky.update(g.dayT, true);
    this.game.toast(names[i]);
  }

  cycleTide() {
    const w = this.game.water;
    const speeds = [0, 1, 4, 12];
    const names = ['Maree figee', 'Maree normale', 'Maree acceleree', 'Maree rapide'];
    const i = (speeds.indexOf(w.tideSpeed) + 1) % speeds.length;
    w.tideSpeed = speeds[i];
    this.game.toast(names[i]);
  }

  toggleSound() {
    const a = this.game.audio;
    if (!a) return;
    a.setEnabled(!a.enabled);
    this.btnSound.replaceChildren(icon(a.enabled ? UI_ICONS.sound : UI_ICONS.mute, 21));
    this.btnSound.classList.toggle('off', !a.enabled);
  }

  toggleBeachPanel(force = null) {
    const open = force == null ? this.beachPanel.style.display === 'none' : !!force;
    this.beachPanel.style.display = open ? 'flex' : 'none';
    this.btnNew.classList.toggle('active', open);
    if (!open) return;
    const info = this.game.beachInfo;
    if (info) {
      this.beachChoice = BEACH_STYLES.some((st) => st.id === info.style) ? info.style : 'classique';
      this.beachParams = beachParamsOf(info.params || info.style);
      this.beachSeed.value = String((Math.random() * 1e9) | 0);
      this.beachSizeX.value = String(NX);
      this.beachSizeZ.value = String(NZ);
      this.syncCustomControls();
    }
    this.syncBeachPanel();
  }

  syncBeachPanel() {
    const info = this.game.beachInfo;
    const cur = BEACH_STYLES.find((st) => st.id === info?.style);
    const size = `${(NX * VOXEL).toFixed(1)} m x ${(NZ * VOXEL).toFixed(1)} m`.replace(/\./g, ',');
    this.beachCurrent.textContent = info
      ? `Plage actuelle : ${cur ? cur.name : 'personnalisee'}${info.params?.custom ? ' (personnalisee)' : ''}, ${size}, graine ${info.seed}.`
      : '';
    for (const b of this.beachCards) b.classList.toggle('active', b.dataset.id === this.beachChoice);
  }

  /** Bornes des jauges qui dependent de la taille choisie (le rivage). */
  syncCustomBounds() {
    const nz = Number(this.beachSizeZ?.value || NZ);
    const halfD = nz * VOXEL * 0.5;
    for (const c of this.customControls) {
      const f = c.field;
      let min = typeof f.min === 'function' ? f.min() : f.min;
      let max = typeof f.max === 'function' ? f.max() : f.max;
      if (f.key === 'shoreC') { min = -halfD + 2.0; max = halfD - 2.0; }
      c.input.min = min; c.input.max = max;
    }
  }

  /** Recale les jauges de personnalisation sur `beachParams`. */
  syncCustomControls() {
    this.syncCustomBounds();
    for (const c of this.customControls) {
      const v = this.beachParams[c.field.key];
      c.input.value = String(v);
      c.value.textContent = c.format(v);
    }
    for (const { feat, input } of this.customFeatures) input.checked = feat.test(this.beachParams);
    this.refreshCustomSketch();
  }

  refreshCustomSketch() {
    const fresh = profileSketch(this.beachParams);
    fresh.classList.add('beach-sketch-big');
    this.customSketch.replaceWith(fresh);
    this.customSketch = fresh;
  }

  toggleHelp() {
    const on = this.help.style.display === 'none';
    this.help.style.display = on ? 'flex' : 'none';
  }

  toggleDebug() {
    this.debug.style.display = this.debug.style.display === 'none' ? 'block' : 'none';
  }

  setHidden(h) {
    this.hidden = h;
    this.root.classList.toggle('hidden', h);
  }

  toast(msg) {
    const t = el('div', 'toast', this.toastBox);
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => {
      t.classList.remove('in');
      setTimeout(() => t.remove(), 400);
    }, 2600);
    while (this.toastBox.childElementCount > 4) this.toastBox.firstChild.remove();
  }

  /**
   * L'outil courant est-il plante dans le sable plutot que tenu ? On le dit
   * par une icone en creux dans la barre — pas par un texte : le joueur voit
   * deja son outil au sol.
   */
  setToolStowed(on) {
    const id = this.game.tools?.current?.id;
    for (const b of this.toolButtons) {
      b.classList.toggle('stowed', on && b.dataset.id === id);
    }
  }

  setActiveTool(tool) {
    if (!tool) return;
    for (const b of this.toolButtons) {
      b.classList.toggle('active', b.dataset.id === tool.id);
      if (b.dataset.id === tool.id) b.classList.remove('stowed');
    }
    this.toolInfoName.textContent = tool.name;
    let hint = tool.hint;
    if (tool.id === 'decor') {
      hint = `${DECOR_VARIANTS[tool.variant].name} — ${tool.hint2}`;
    } else if (tool.id === 'rake') {
      hint = `${tool.hint} (ecart ${Math.round(tool.spacing * 100)} cm)`;
    } else if (tool.id === 'hand') {
      hint = `${tool.hint} (intensité ${Math.round((tool.intensity ?? 0.5) * 100)} %)`;
    } else if (tool.id === 'sand') {
      hint = {
        block: 'Bloc carré ou rectangulaire — clique pour poser.',
        wall: 'Mur courbe — maintiens le clic et dessine son trajet.',
        tower: 'Tour ronde, avec ou sans toit — clique pour poser.',
        dome: 'Dôme — clique pour poser.',
      }[tool.mode] || tool.hint;
    }
    this.toolInfoHint.textContent = hint;
    this.toolInfoSize.textContent = tool.id === 'sand'
      ? ({ block: 'Bloc', wall: 'Spline', tower: 'Tour', dome: 'Dôme' }[tool.mode] || '')
      : `${Math.round(this.game.tools.radius * 100)} cm`;
    this.syncBuilderPanel(tool);
    this.syncHandPanel(tool);
    this.syncToolPanel(tool);
  }

  /** Etat du bouton miroir. */
  setMirror(on, axis) {
    this.btnMirror.classList.toggle('active', !!on);
    this.btnMirror.title = on
      ? `Miroir ${axis === 'x' ? 'gauche-droite' : 'avant-arrière'} (M : couper, Maj+M : autre axe)`
      : 'Miroir (M) — Maj+M : autre axe';
  }

  /**
   * Panneau de reglages de l'outil courant, d'apres sa description `panel`.
   * Reconstruit au changement d'outil, recale a chaque appel.
   */
  syncToolPanel(tool) {
    const spec = tool?.panel;
    if (!spec) { this.toolPanel.style.display = 'none'; this._toolPanelFor = null; return; }
    const fmt = {
      cm: (v) => `${Math.round(v * 100)} cm`,
      mm: (v) => `${Math.round(v * 1000)} mm`,
      pct: (v) => `${Math.round(v * 100)} %`,
      deg: (v) => `${Math.round(v * 180 / Math.PI)}°`,
    };
    if (this._toolPanelFor !== tool.id) {
      this._toolPanelFor = tool.id;
      this._toolPanelControls = [];
      this.toolPanel.textContent = '';
      el('div', 'panel-title', this.toolPanel).textContent = tool.name;
      for (const group of spec.groups || []) {
        const row = el('div', 'builder-modes tool-modes', this.toolPanel);
        const buttons = [];
        for (const opt of group.options) {
          const b = el('button', 'builder-mode', row);
          b.textContent = opt.label;
          b.addEventListener('click', () => {
            this.game.tools.setToolSetting(tool.id, group.key, opt.id);
            this.game.audio?.play('ui');
            this.syncToolPanel(tool);
          });
          buttons.push({ id: opt.id, button: b });
        }
        this._toolPanelControls.push({ kind: 'group', key: group.key, buttons });
      }
      const section = el('div', 'builder-section', this.toolPanel);
      for (const r of spec.ranges || []) {
        const row = el('label', 'builder-row', section);
        el('span', 'builder-label', row).textContent = r.label;
        const input = el('input', 'builder-range', row);
        input.type = 'range'; input.min = r.min; input.max = r.max; input.step = r.step;
        const value = el('span', 'builder-value', row);
        const format = fmt[r.format] || ((v) => String(v));
        input.addEventListener('input', () => {
          const v = Number(input.value);
          value.textContent = format(v);
          this.game.tools.setToolSetting(tool.id, r.key, v);
        });
        this._toolPanelControls.push({ kind: 'range', key: r.key, input, value, format });
      }
      if (spec.tip) el('div', 'builder-tip', this.toolPanel).textContent = spec.tip;
    }
    for (const c of this._toolPanelControls) {
      if (c.kind === 'group') {
        for (const b of c.buttons) b.button.classList.toggle('active', tool[c.key] === b.id);
      } else {
        c.input.value = String(tool[c.key]);
        c.value.textContent = c.format(tool[c.key]);
      }
    }
    this.toolPanel.style.display = 'block';
  }

  /** Jauge d'intensite de la main : visible avec l'outil, recalee sur sa valeur. */
  syncHandPanel(tool) {
    const active = tool?.id === 'hand';
    this.handPanel.style.display = active ? 'block' : 'none';
    if (!active) return;
    const v = Math.round((tool.intensity ?? 0.5) * 20) * 5;
    this.handControl.input.value = String(v);
    this.handControl.show(v);
  }

  syncBuilderPanel(tool) {
    const active = tool?.id === 'sand';
    this.builderPanel.style.display = active ? 'block' : 'none';
    if (active) this.toggleSeaPanel(false);
    if (!active) return;
    this.builderModeBlock.classList.toggle('active', tool.mode === 'block');
    this.builderModeWall.classList.toggle('active', tool.mode === 'wall');
    this.builderModeTower.classList.toggle('active', tool.mode === 'tower');
    this.builderModeDome.classList.toggle('active', tool.mode === 'dome');
    this.builderBlock.style.display = tool.mode === 'block' ? 'flex' : 'none';
    this.builderWall.style.display = tool.mode === 'wall' ? 'flex' : 'none';
    this.builderTower.style.display = tool.mode === 'tower' ? 'flex' : 'none';
    this.builderDome.style.display = tool.mode === 'dome' ? 'flex' : 'none';
    this.builderRoof.checked = !!tool.roof;
    this.builderRoofControls.classList.toggle('disabled', !tool.roof);
    for (const control of this.builderControls) {
      const v = tool[control.key];
      control.input.value = String(v);
      control.value.textContent = control.format(v);
    }
    this.builderCrenels.checked = !!tool.crenels;
    this.builderCrenelControls.classList.toggle('disabled', !tool.crenels);
  }

  // -------------------------------------------------------------------------
  // MISE A JOUR
  // -------------------------------------------------------------------------

  update(dt) {
    const g = this.game;
    if (this.hidden) return;

    // La regle ecrit sa mesure dans l'infobulle, en direct.
    const cur = g.tools.current;
    if (cur.readout !== undefined) {
      const text = cur.readout || cur.hint;
      if (this.toolInfoHint.textContent !== text) this.toolInfoHint.textContent = text;
    }

    // Compte a rebours de la sauvegarde automatique, une fois par seconde.
    if (this.savePanel.style.display !== 'none') {
      this._saveTick += dt;
      if (this._saveTick >= 1) { this._saveTick = 0; this.syncSavePanel(); }
    }

    // --- humidite sous le curseur ------------------------------------------
    const probe = g.tools.probe();
    const w = probe ? probe.moisture : g.lastProbeMoisture || 0;
    const pk = probe ? probe.packing : 0;
    g.lastProbeMoisture = w;

    const cat = moistureCategory(w);
    this.moistLabel.textContent = cat.label;
    this.moistHint.textContent = cat.hint;
    this.moistSwatch.style.background = moistureColor(w);
    this.moistSwatch.className = 'sand-swatch ' + cat.key;

    // Echelle non lineaire : les premiers pourcents comptent enormement.
    const pos = clamp(Math.pow(w, 0.42), 0, 1);
    this.moistMarker.style.left = `${pos * 100}%`;
    if (!this._sweetSet) {
      const a = Math.pow(0.04, 0.42), b = Math.pow(0.25, 0.42);
      this.moistSweet.style.left = `${a * 100}%`;
      this.moistSweet.style.width = `${(b - a) * 100}%`;
      this._sweetSet = true;
    }

    const pkCat = packingCategory(pk);
    this.rowPack.bar.style.width = `${pk * 100}%`;
    this.rowPack.val.textContent = pkCat.label;

    const theta = thetaMax(w, pk);
    this.rowHold.bar.style.width = `${clamp((theta - 30) / 60, 0, 1) * 100}%`;
    this.rowHold.val.textContent =
      theta > 84 ? 'Verticale' : theta > 70 ? 'Tres raide' :
      theta > 55 ? 'Raide' : theta > 42 ? 'Moyenne' : 'Ca coule';

    const depth = probe ? probe.waterDepth : 0;
    this.rowWater.bar.style.width = `${clamp(depth / 0.3, 0, 1) * 100}%`;
    this.rowWater.val.textContent =
      depth < 0.003 ? '—' : depth < 0.05 ? 'Flaque' : depth < 0.2 ? 'Peu profond' : 'Profond';

    // --- maree --------------------------------------------------------------
    const tp = g.water.tidePhase;
    const rising = g.water.tide > (this._lastTide ?? 0);
    this._lastTide = g.water.tide;
    this.tideChip.textContent =
      tp > 0.88 ? 'Maree haute' : tp < 0.12 ? 'Maree basse' :
      rising ? 'Maree montante' : 'Maree descendante';
    this.tideChip.classList.toggle('warn', tp > 0.7 && rising);

    // --- pelletee ------------------------------------------------------------
    const c = g.carried;
    const litres = c.volume * 1000;
    this.resText.textContent = litres < 0.2 ? 'Pelle vide' :
      `${litres.toFixed(1)} L de ${moistureCategory(c.moisture).label.toLowerCase()}`;

    // La jauge de remplissage du seau a disparu de l'interface : le sable
    // MONTE VISIBLEMENT dans le seau (ToolAvatar / BucketRig), et sa couleur
    // dit son humidite. L'interface ne garde que ce que le monde ne peut pas
    // montrer.

    this.toolInfoSize.textContent = g.tools.current.id === 'sand'
      ? (g.tools.current.mode === 'block' ? 'Bloc' : 'Spline')
      : `${Math.round(g.tools.radius * 100)} cm`;

    // --- diagnostics ---------------------------------------------------------
    if (this.debug.style.display !== 'none') {
      const s = g.stats;
      this.debugStats.textContent =
        `${s.fps.toFixed(0)} fps | sim ${s.sim.toFixed(1)} ms\n` +
        `triangles ${(s.triangles / 1000).toFixed(0)} k | maillage ${s.meshQueue}${g.mesher?.shared ? ' (memoire partagee)' : ''}\n` +
        `voxels actifs ${s.activeVoxels} | cellules d eau ${s.wetCells}\n` +
        `eau ${g.water.stats.ms.toFixed(1)} ms ${g.water.gpu ? g.water.gpu.label : 'CPU'} | ${g.water.substepCount} sous-pas | gouttes ${g.water.droplets.count}\n` +
        `humidite ${(w * 100).toFixed(1)} % | compaction ${(pk * 100).toFixed(0)} %\n` +
        `theta_max ${theta.toFixed(1)} deg | maree ${(tp * 100).toFixed(0)} %\n` +
        `annulation ${(g.tools.undo.bytes / 1048576).toFixed(1)} Mo | props ${g.props?.count ?? 0}`;
    }
  }
}

/** Couleur du sable pour une saturation donnee (memes lois que le shader). */
function moistureColor(w) {
  const ws = 1 - Math.exp(-w * 7.5);
  const base = [0.894, 0.812, 0.635];
  const lum = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
  const lumWet = Math.pow(lum, 1 + 0.95 * ws) * (1 - 0.28 * ws);
  const k = lumWet / lum;
  const c = base.map((v) => clamp(v * k, 0, 1));
  return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
}

const HELP_HTML = `
<div class="help-card">
  <h2>Comment ca marche</h2>
  <div class="help-cols">
    <div>
      <h3>Souris</h3>
      <ul>
        <li><b>Clic gauche</b> — action principale de l outil</li>
        <li><b>Clic droit</b> — action inverse</li>
        <li><b>Molette</b> — zoom, centre sur le curseur</li>
        <li><b>Ctrl + molette</b> — rayon de la brosse</li>
        <li><b>Clic molette</b> — pivoter la camera</li>
        <li><b>Maj + clic molette</b> — deplacer la camera</li>
        <li><b>Alt + clic gauche</b> — pivoter (souris sans molette)</li>
      </ul>
      <h3>Clavier</h3>
      <ul>
        <li><b>1 a 0</b> — outils &nbsp; <b>V</b> — seau de sable &nbsp; <b>B</b> — construction en sable</li>
        <li><b>F</b> ouverture &nbsp; <b>T</b> escalier &nbsp; <b>U</b> gouge &nbsp; <b>X</b> paille &nbsp; <b>R</b> regle &nbsp; <b>M</b> miroir (<b>Maj+M</b> : autre axe)</li>
        <li><b>Ctrl+Z / Ctrl+Maj+Z</b> — annuler / refaire</li>
        <li><b>Ctrl</b> (pendant un geste) — verrouiller l altitude</li>
        <li><b>Maj</b> — modificateur d outil</li>
        <li><b>W A S D / Q E</b> — camera</li>
        <li><b>G</b> — planter l outil dans le sable (<b>Maj+G</b> : le poser a plat)</li>
        <li><b>Clic</b> sur un outil au sol — le reprendre en main</li>
        <li><b>P</b> — mode photo &nbsp; <b>H</b> — cette aide &nbsp; <b>F3</b> — diagnostics</li>
        <li><b>Ctrl+S / Ctrl+O</b> — sauvegarder / recharger la plus recente (historique et sauvegarde automatique : bouton disquette)</li>
        <li><b>[ ]</b> — rayon de brosse au clavier</li>
      </ul>
    </div>
    <div>
      <h3>Le sable, en trois phrases</h3>
      <p>Le sable <b>sec</b> ne tient rien : il coule a 34 degres, quoi que tu fasses.
      Quelques pourcents d eau suffisent a creer des <b>ponts capillaires</b> entre les
      grains, et la il tient <b>presque a la verticale</b>. Trop d eau et les ponts
      fusionnent : le sable se liquefie et s affaisse.</p>
      <p>Vise la zone verte du thermometre. Puis <b>tasse</b> avec la main : la compaction
      multiplie les contacts entre grains et double la hauteur tenable.</p>
      <h3>La methode des sculpteurs</h3>
      <ol>
        <li>Creuse jusqu au sable humide (la nappe n est pas loin).</li>
        <li>Empile, mouille, <b>tasse</b> couche par couche.</li>
        <li>Sculpte <b>toujours du haut vers le bas</b> : ce qui tombe abime le bas.</li>
        <li>Une douve autour protege du ressac. La maree finira par tout reprendre.</li>
      </ol>
    </div>
  </div>
  <p class="help-close">Appuie sur H ou Echap pour fermer</p>
</div>
`;
