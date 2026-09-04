/**
 * Generation de la plage de depart.
 *
 * Profil de plage realiste : arriere-plage seche et bombee (berme), face de
 * plage en pente douce (5 a 12 %), estran humide, puis l'eau. On depose aussi
 * les rides du ressac, quelques rochers, et surtout le champ d'humidite
 * initial issu de la nappe phreatique et de sa frange capillaire.
 *
 * STYLES. Le profil, la position du rivage, les dunes, les rides et le decor
 * sont parametres par un style (BEACH_STYLES) : grande plage plate, lagon,
 * crique, dunes, maree basse, plage pentue, banc de sable, recif, falaise.
 * Le style COURANT (BEACH) est un etat de module, parce que l'eau et la
 * houle interrogent `beachProfile`, `shorelineFor` et `shoreDistance` sans
 * connaitre la plage : changer de style, c'est appeler `applyBeachStyle`
 * puis reconstruire leurs cartes de rivage (Water.rebuildShore). Une meme
 * graine et un meme style redonnent exactement la meme plage.
 */

import {
  NX, NY, NZ, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, ISO, WORLD_W, WORLD_D,
  SEA_LEVEL, BEACH_HEIGHT, CAPILLARY_FRINGE, RESIDUAL_SATURATION,
  WATER_TABLE_DROP, WATER_TABLE_SPAN,
  MAT_SAND, MAT_ROCK, MAT_SHELL,
  clamp, smoothstep, lerp,
} from '../core/Config.js';
import { Noise } from './Noise.js';

/**
 * Les styles de plage. Chaque champ a une valeur physique :
 *   shoreC     position du rivage moyen le long de la normale (m) : plus il
 *              est grand, plus la mer est repoussee et plus il y a de sable
 *   wiggle     amplitude du bruit de la ligne d'eau (m)
 *   bay        creux d'une anse au centre de la plage (m), 0 = rivage droit
 *   depth      profondeur du large sous la mer moyenne (m)
 *   foreshore  longueur de l'avant-plage immergee (m), forePow sa courbure
 *              (< 1 : haut-fond qui s'aplatit vers le rivage ; > 1 : creux)
 *   face       longueur de la face de plage jusqu'a la berme (m), facePow sa courbure
 *   berm       altitude de la crete de berme (m)
 *   backSlope  contre-pente de l'arriere-plage
 *   dune       amplitude des dunes (m) entre duneFrom et duneTo (m du rivage)
 *   ripple, grain, offshore : amplitudes des rides du ressac, du grain, du fond
 *   bar        banc ou recif au large : {at, width, height, top, rock}
 *   cliff      falaise a l'arriere : {at, width, height}
 *   decor      multiplicateurs de densite du decor par espece
 */
const BASE = {
  shoreC: 0.4, wiggle: 0.62, bay: 0,
  depth: 0.86, foreshore: 3.2, forePow: 0.85,
  face: 3.6, facePow: 0.78, berm: BEACH_HEIGHT, backSlope: 0.045,
  dune: 0.16, duneFrom: 2.0, duneTo: 6.0,
  ripple: 0.022, grain: 0.012, offshore: 0.05,
  bar: null, cliff: null,
  decor: {},
};
export const BEACH_STYLES = [
  { id: 'classique', name: 'Plage classique',
    blurb: 'Berme, face de plage a 8 %, estran humide et haut-fond : la plage de depart.' },
  { id: 'grande', name: 'Grande plage plate',
    blurb: 'Huit metres de sable presque plat, la mer repoussee au loin : de la place pour une cite entiere.',
    shoreC: 2.2, wiggle: 0.5, depth: 0.70, foreshore: 2.6, forePow: 0.9,
    face: 6.5, facePow: 0.95, berm: SEA_LEVEL + 0.34, backSlope: 0.02,
    dune: 0.05, duneFrom: 5.0, duneTo: 9.0, ripple: 0.014, grain: 0.010, offshore: 0.03,
    decor: { grass: 0.4 } },
  { id: 'lagon', name: 'Lagon',
    blurb: 'De l eau turquoise a hauteur de genou sur des metres, du corail et des herbiers.',
    shoreC: 0.0, wiggle: 0.40, depth: 0.42, foreshore: 5.0, forePow: 0.35,
    face: 3.0, facePow: 0.80, berm: SEA_LEVEL + 0.42, backSlope: 0.03,
    dune: 0.08, duneFrom: 2.0, duneTo: 6.0, ripple: 0.010, grain: 0.010, offshore: 0.02,
    decor: { coral: 2.2, brain: 2, table: 2, fan: 1.8, seagrass: 1.4 } },
  { id: 'crique', name: 'Crique',
    blurb: 'Une anse en arc, resserree entre deux pointes rocheuses, a l abri de la houle.',
    shoreC: 0.8, wiggle: 0.30, bay: 1.7, depth: 0.86, foreshore: 2.8, forePow: 0.85,
    face: 3.0, facePow: 0.70, berm: BEACH_HEIGHT + 0.1, backSlope: 0.06,
    dune: 0.20, duneFrom: 2.0, duneTo: 6.0, ripple: 0.020, grain: 0.012, offshore: 0.05,
    decor: { seaRocks: 3.5, urchins: 1.6, pebbles: 1.8 } },
  { id: 'dunes', name: 'Dunes',
    blurb: 'Une berme haute et de vraies dunes a l arriere, couvertes d oyats.',
    shoreC: 0.4, wiggle: 0.62, depth: 0.86, foreshore: 3.2, forePow: 0.85,
    face: 3.4, facePow: 0.78, berm: BEACH_HEIGHT + 0.35, backSlope: 0.09,
    dune: 0.45, duneFrom: 1.5, duneTo: 5.0, ripple: 0.022, grain: 0.012, offshore: 0.05,
    decor: { grass: 2.6, pebbles: 0.6 } },
  { id: 'vasiere', name: 'Maree basse',
    blurb: 'Un estran immense et plat, ride par le ressac : la mer y avance et recule de plusieurs metres.',
    shoreC: 1.6, wiggle: 0.45, depth: 0.60, foreshore: 4.4, forePow: 1.0,
    face: 7.0, facePow: 1.0, berm: SEA_LEVEL + 0.30, backSlope: 0.02,
    dune: 0.03, duneFrom: 6.0, duneTo: 9.0, ripple: 0.035, grain: 0.010, offshore: 0.03,
    decor: { shells: 1.6, starfish: 1.5, grass: 0.3 } },
  { id: 'galets', name: 'Plage pentue',
    blurb: 'Une face raide a 20 %, la mer tout pres, des galets : un site pour un chateau vertical.',
    shoreC: -0.6, wiggle: 0.45, depth: 0.90, foreshore: 2.4, forePow: 0.80,
    face: 1.6, facePow: 0.90, berm: BEACH_HEIGHT + 0.10, backSlope: 0.05,
    dune: 0.12, duneFrom: 2.0, duneTo: 5.0, ripple: 0.018, grain: 0.014, offshore: 0.06,
    decor: { pebbles: 3.0, shells: 0.6, seaRocks: 1.5 } },
  { id: 'banc', name: 'Banc de sable',
    blurb: 'Un banc emerge au large et, derriere lui, une lagune calme a traverser.',
    shoreC: 0.4, wiggle: 0.5, depth: 0.80, foreshore: 3.4, forePow: 0.85,
    face: 3.6, facePow: 0.78, berm: BEACH_HEIGHT, backSlope: 0.045,
    dune: 0.14, duneFrom: 2.0, duneTo: 6.0, ripple: 0.022, grain: 0.012, offshore: 0.04,
    bar: { at: -2.3, width: 0.55, height: 0.95, top: SEA_LEVEL + 0.11, rock: false },
    decor: { shells: 1.3, starfish: 1.6 } },
  { id: 'recif', name: 'Recif barriere',
    blurb: 'Une barre rocheuse au large casse la houle ; derriere, un lagon plat et clair.',
    shoreC: 0.2, wiggle: 0.40, depth: 0.60, foreshore: 4.6, forePow: 0.40,
    face: 3.2, facePow: 0.80, berm: SEA_LEVEL + 0.45, backSlope: 0.03,
    dune: 0.08, duneFrom: 2.0, duneTo: 6.0, ripple: 0.012, grain: 0.010, offshore: 0.02,
    bar: { at: -4.1, width: 0.45, height: 0.75, top: SEA_LEVEL - 0.03, rock: true },
    decor: { coral: 2.4, brain: 2.2, table: 2, fan: 2, urchins: 2, seaRocks: 1.5 } },
  { id: 'falaise', name: 'Pied de falaise',
    blurb: 'Une plage etroite au pied d une falaise de sable dur : un decor pour tailler des bas-reliefs.',
    shoreC: 0.0, wiggle: 0.45, depth: 0.86, foreshore: 3.0, forePow: 0.85,
    face: 3.2, facePow: 0.78, berm: BEACH_HEIGHT - 0.05, backSlope: 0.05,
    dune: 0.06, duneFrom: 2.0, duneTo: 4.0, ripple: 0.020, grain: 0.012, offshore: 0.05,
    cliff: { at: 4.3, width: 0.40, height: 0.75 },
    decor: { pebbles: 1.6, grass: 0.5 } },
].map((st) => ({ ...BASE, ...st, decor: { ...st.decor } }));

export const BEACH_STYLE_BY_ID = Object.fromEntries(BEACH_STYLES.map((st) => [st.id, st]));

/** Le style courant : ce que lisent le profil, le rivage et la houle. */
export const BEACH = { ...BEACH_STYLES[0], decor: { ...BEACH_STYLES[0].decor } };

/** Marge de mer et de sable garantie de part et d'autre du rivage (m). */
export const SHORE_MARGIN = 2.0;

/** Bornes du rivage pour la carte courante : au moins SHORE_MARGIN de chaque cote. */
export function shoreRange() {
  return { min: -WORLD_D * 0.5 + SHORE_MARGIN, max: WORLD_D * 0.5 - SHORE_MARGIN };
}

/**
 * Rend un style courant : un identifiant de BEACH_STYLES, ou un objet de
 * parametres libres (les champs absents prennent ceux de la plage
 * classique). Le rivage est borne a la carte et l'avant-plage a la mer
 * disponible. Renvoie les parametres appliques.
 */
export function applyBeachStyle(styleOrParams) {
  let st;
  if (styleOrParams && typeof styleOrParams === 'object') {
    const base = BEACH_STYLE_BY_ID[styleOrParams.id] || BEACH_STYLES[0];
    st = { ...BASE, ...base, ...styleOrParams, decor: { ...base.decor, ...(styleOrParams.decor || {}) } };
    if (!BEACH_STYLE_BY_ID[st.id]) st.id = 'custom';
    if (st.bar && typeof st.bar !== 'object') st.bar = null;
    if (st.cliff && typeof st.cliff !== 'object') st.cliff = null;
  } else {
    st = BEACH_STYLE_BY_ID[styleOrParams] || BEACH_STYLES[0];
  }
  const range = shoreRange();
  const params = { ...st, decor: { ...st.decor } };
  params.shoreC = clamp(params.shoreC, range.min, range.max);
  params.foreshore = clamp(params.foreshore, 0.6, WORLD_D * 0.5 - params.shoreC - 0.4);
  // Un gabarit retouche garde son nom (c'est de lui qu'il vient) mais se
  // signale comme personnalise.
  const ref = BEACH_STYLE_BY_ID[params.id];
  params.custom = !ref || CUSTOM_KEYS.some((k) => Math.abs((params[k] ?? 0) - (ref[k] ?? 0)) > 1e-9)
    || !!params.bar !== !!ref.bar || !!params.cliff !== !!ref.cliff
    || (!!params.bar && !!ref.bar && !!params.bar.rock !== !!ref.bar.rock);
  Object.assign(BEACH, params);
  SHORE_C = params.shoreC;
  return params;
}

/** Les champs numeriques qu'un joueur peut retoucher. */
const CUSTOM_KEYS = ['shoreC', 'depth', 'foreshore', 'forePow', 'face', 'berm', 'backSlope', 'dune', 'bay', 'wiggle', 'ripple'];

/** Les parametres libres exposes au joueur, avec leurs bornes et leur unite. */
export const CUSTOM_FIELDS = [
  { key: 'shoreC', label: 'Debut de la mer', min: () => shoreRange().min, max: () => shoreRange().max, step: 0.1, format: 'm',
    tip: 'Position du rivage : plus il est loin, plus il y a de sable.' },
  { key: 'depth', label: 'Profondeur du large', min: 0.2, max: 1.4, step: 0.02, format: 'cm' },
  { key: 'foreshore', label: 'Avant-plage', min: 0.6, max: 9.0, step: 0.1, format: 'm', tip: 'Longueur du haut-fond immerge.' },
  { key: 'forePow', label: 'Haut-fond', min: 0.3, max: 1.6, step: 0.05, format: 'x', tip: 'Sous 1, le fond s aplatit vers le rivage (lagon) ; au-dessus, il se creuse.' },
  { key: 'face', label: 'Face de plage', min: 0.6, max: 9.0, step: 0.1, format: 'm' },
  { key: 'berm', label: 'Hauteur de berme', min: SEA_LEVEL + 0.15, max: SEA_LEVEL + 1.2, step: 0.02, format: 'cm' },
  { key: 'backSlope', label: 'Contre-pente', min: 0, max: 0.15, step: 0.005, format: 'pct' },
  { key: 'dune', label: 'Dunes', min: 0, max: 0.8, step: 0.02, format: 'cm' },
  { key: 'bay', label: 'Anse', min: 0, max: 3.0, step: 0.1, format: 'm', tip: 'Creux d une crique au centre de la plage.' },
  { key: 'wiggle', label: 'Sinuosite', min: 0, max: 1.5, step: 0.05, format: 'm' },
  { key: 'ripple', label: 'Rides du ressac', min: 0, max: 0.06, step: 0.002, format: 'mm' },
];

/** Les elements optionnels : un banc, un recif, une falaise, a leur place par defaut. */
export const CUSTOM_FEATURES = [
  { key: 'bar', label: 'Banc de sable au large',
    make: (P) => ({ at: -0.68 * P.foreshore, width: 0.55, height: 0.95, top: SEA_LEVEL + 0.11, rock: false }),
    test: (P) => !!P.bar && !P.bar.rock },
  { key: 'reef', label: 'Recif barriere',
    make: (P) => ({ at: -0.88 * P.foreshore, width: 0.45, height: 0.75, top: SEA_LEVEL - 0.03, rock: true }),
    test: (P) => !!P.bar && !!P.bar.rock },
  { key: 'cliff', label: 'Falaise a l arriere',
    make: (P) => ({ at: P.face + 0.7, width: 0.40, height: 0.75 }),
    test: (P) => !!P.cliff },
];

/** Copie plate des parametres d'un style, prete a etre editee ou sauvegardee. */
export function beachParamsOf(styleOrParams) {
  const st = styleOrParams && typeof styleOrParams === 'object' ? styleOrParams : (BEACH_STYLE_BY_ID[styleOrParams] || BEACH_STYLES[0]);
  const out = { ...BASE, ...st, decor: { ...(st.decor || {}) } };
  if (st.bar) out.bar = { ...st.bar };
  if (st.cliff) out.cliff = { ...st.cliff };
  delete out.name; delete out.blurb;
  return out;
}

/** Une graine a partir d'un texte : un nombre tel quel, sinon un hachage FNV-1a. */
export function seedFromText(text) {
  const t = String(text ?? '').trim();
  if (/^-?\d{1,10}$/.test(t)) return Math.abs(parseInt(t, 10)) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Normale de la ligne de rivage (pointe vers la mer), dans le plan XZ.
 *
 * La mer occupe toute la face +Z du diorama et la plage lui fait face sur
 * toute sa largeur : c'est la disposition d'une vraie plage, pas un coin
 * d'eau. Le bruit de shoreDistance() garde a la ligne d'eau ses courbes.
 */
export const SHORE_NX = 0.0;
export const SHORE_NZ = 1.0;
/** Position du rivage moyen le long de la normale (m) : z = SHORE_C. Suit le style. */
export let SHORE_C = 0.4;

/**
 * Distance signee au rivage en metres. > 0 = cote terre. L'anse d'une crique
 * (BEACH.bay) fait partie du rivage : l'eau et la houle la voient aussi.
 */
export function shoreDistance(wx, wz, noise) {
  let d = SHORE_C - (SHORE_NX * wx + SHORE_NZ * wz);
  if (BEACH.bay) {
    const along = -SHORE_NZ * wx + SHORE_NX * wz;
    d -= BEACH.bay * (0.5 + 0.5 * Math.cos((2 * Math.PI * along) / WORLD_W));
  }
  if (noise) d += BEACH.wiggle * noise.fbm2(wx * 0.17, wz * 0.17, 3);
  return d;
}

/**
 * Profil altimetrique de la plage en fonction de la distance au rivage,
 * pour le style courant ou un style donne. Monotone : c'est ce qui permet
 * a shorelineFor de l'inverser.
 * @param {number} d distance signee (m), positive vers la terre
 */
export function beachProfile(d, P = BEACH) {
  // L'avant-plage doit descendre plus bas que la basse mer, sinon la mer
  // disparait completement a maree basse.
  const DEEP = SEA_LEVEL - P.depth;
  if (d <= -P.foreshore) return DEEP;
  if (d <= 0) {
    // Avant-plage immergee, raccordee EXACTEMENT au niveau moyen de la mer
    // en d = 0 (une marche ici deplacerait la ligne d'eau).
    const t = smoothstep(-P.foreshore, 0, d);
    return DEEP + (SEA_LEVEL - DEEP) * Math.pow(t, P.forePow);
  }
  if (d <= P.face) {
    // Face de plage : monte jusqu'a la crete de berme
    const t = d / P.face;
    return SEA_LEVEL + (P.berm - SEA_LEVEL) * smoothstep(0, 1, Math.pow(t, P.facePow));
  }
  // Arriere-plage : quasi plate, legere contre-pente vers la dune
  return P.berm + P.backSlope * (d - P.face);
}

/**
 * Distance au rivage a laquelle le terrain atteint une altitude donnee.
 * Autrement dit : ou se trouve la ligne d'eau quand la mer est a `level` ?
 * Inversion numerique du profil (il est monotone, une dichotomie suffit).
 */
export function shorelineFor(level, P = BEACH) {
  let lo = -P.foreshore, hi = P.face + 4.0;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) * 0.5;
    if (beachProfile(mid, P) < level) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Altitude de la nappe phreatique pour une distance au rivage courant.
 * Doit rester coherente avec Water.updateWaterTable.
 */
export function waterTableFor(shoreDistFromWaterline, seaLevel = SEA_LEVEL) {
  return seaLevel - 0.02 -
    WATER_TABLE_DROP * smoothstep(0, WATER_TABLE_SPAN, shoreDistFromWaterline);
}

/**
 * @param {import('../sim/VoxelField.js').VoxelField} field
 * @param {number} seed
 * @param {string|object} [style] style de plage (identifiant ou parametres libres) ; rend ce style courant
 */
export function generateBeach(field, seed = 20260901, style = 'classique') {
  const P = applyBeachStyle(style);
  const noise = new Noise(seed);
  const nRipple = new Noise(seed ^ 0x9e3779b9);
  const nGrain = new Noise(seed ^ 0x51ed270b);

  const dens = field.density;
  const mois = field.moisture;
  const pack = field.packing;
  const mat = field.material;

  dens.fill(0);
  mois.fill(0);
  pack.fill(0);
  mat.fill(0);

  const heights = new Float32Array(NX * NZ);
  const shoreD = new Float32Array(NX * NZ);
  /** Part de roche du recif par colonne (0 = sable). */
  const rockMask = new Float32Array(NX * NZ);

  // --- 1. carte de hauteur ---------------------------------------------------
  for (let z = 0; z < NZ; z++) {
    const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
    for (let x = 0; x < NX; x++) {
      const wx = ORIGIN_X + (x + 0.5) * VOXEL;
      const d = shoreDistance(wx, wz, noise);
      let h = beachProfile(d);

      // Bosses de dune / relief general de l'arriere-plage
      const dune = smoothstep(P.duneFrom, P.duneTo, d);
      h += dune * P.dune * noise.fbm2(wx * 0.28 + 40, wz * 0.28 - 15, 4);

      // Fond du large : de longues ondulations de sable et quelques bancs,
      // pour que l'eau profonde ait un fond vivant sous la refraction.
      const offshore = smoothstep(-1.4, -3.4, d);
      if (offshore > 0.001) {
        h += offshore * (P.offshore * noise.fbm2(wx * 0.45 - 11, wz * 0.45 + 23, 3)
          + 0.012 * Math.sin(wx * 6.0 + noise.noise2(wz * 0.5, wx * 0.2) * 1.5));
      }

      // Banc de sable ou recif au large : une bosse gaussienne plafonnee.
      // Le banc emerge de quelques centimetres, le recif reste juste sous
      // la mer et casse la houle sans la barrer.
      let rock = 0;
      if (P.bar) {
        const u = (d - P.bar.at) / P.bar.width;
        const g = Math.exp(-(u * u));
        const raised = Math.min(h + P.bar.height * g, Math.max(h, P.bar.top));
        if (P.bar.rock && g > 0.35) rock = g;
        h = raised;
      }
      // Falaise a l'arriere : une marche raide de sable dur.
      if (P.cliff) {
        h += P.cliff.height * smoothstep(P.cliff.at - P.cliff.width, P.cliff.at + P.cliff.width, d);
      }

      // Rides du ressac : petites ondulations paralleles au rivage, dans la
      // zone de balancement des marees.
      const swash = 1 - smoothstep(0.2, 2.6, Math.abs(d));
      if (swash > 0.01) {
        const along = -SHORE_NZ * wx + SHORE_NX * wz;
        const across = SHORE_NX * wx + SHORE_NZ * wz;
        const ripple =
          Math.sin(across * 7.5 + nRipple.noise2(along * 0.4, across * 0.25) * 2.2) * 0.5 + 0.5;
        h += swash * P.ripple * (ripple - 0.5) * 2;
      }

      // Micro-relief general (grain de la plage)
      h += P.grain * nGrain.fbm2(wx * 2.1, wz * 2.1, 3);
      rockMask[x + NX * z] = rock;

      // Bord du domaine : on rabat legerement pour que le bloc diorama
      // ait des cotes nets.
      heights[x + NX * z] = h;
      shoreD[x + NX * z] = d;
    }
  }

  // Les rochers et les coquillages ne sont PAS dans le champ voxel : ce sont
  // des props instancies (voir render/Props.js). Le champ voxel ne contient
  // que du sable, ce qui garde la physique et le maillage homogenes.

  // --- 3. remplissage voxel --------------------------------------------------
  const invFringe = 1 / CAPILLARY_FRINGE;

  for (let z = 0; z < NZ; z++) {
    const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
    for (let x = 0; x < NX; x++) {
      const c = x + NX * z;
      const wx = ORIGIN_X + (x + 0.5) * VOXEL;
      const h = heights[c];
      const d = shoreD[c];

      // Nappe phreatique : affleure au rivage, s'enfonce vers l'arriere-plage.
      const table = waterTableFor(d, SEA_LEVEL);

      const surface = h;
      const yMax = Math.min(NY - 1, Math.ceil((surface - ORIGIN_Y) / VOXEL) + 2);

      for (let y = 0; y <= yMax; y++) {
        const wy = ORIGIN_Y + (y + 0.5) * VOXEL;
        const i = x + NX * (z + NZ * y);

        // Densite = champ de distance signee, adoucie sur un voxel.
        const sdf = (surface - wy) / VOXEL;
        let dv = 128 + sdf * 128;
        if (dv <= 0) continue;
        if (dv > 255) dv = 255;
        dens[i] = dv | 0;
        if (dv < ISO) continue;

        // --- humidite ---
        let w;
        const above = wy - table;
        if (above <= 0) {
          w = 1.0; // sous la nappe : pores satures
        } else {
          const t = above * invFringe;
          w = t >= 1
            ? RESIDUAL_SATURATION
            : RESIDUAL_SATURATION + (0.95 - RESIDUAL_SATURATION) * Math.pow(1 - t, 1.6);
        }

        // Sechage par le soleil et le vent sur les premiers centimetres,
        // sauf dans la zone de balancement ou le ressac re-mouille tout.
        const depth = surface - wy;
        const exposed = 1 - smoothstep(0.0, 0.14, depth);
        const tidal = 1 - smoothstep(0.0, 1.4, d); // 1 pres de l'eau
        const dryness = exposed * (1 - tidal) * 0.88;
        w = w * (1 - dryness);
        // Variation naturelle
        w *= 1 + 0.08 * nGrain.fbm2(wx * 3.3 + 12, wz * 3.3 - 7, 2);
        w = clamp(w, 0, 1);

        mois[i] = (w * 255) | 0;
        let pk = clamp(0.18 + 0.5 * w + 0.25 * smoothstep(0.3, 1.2, depth), 0, 1);
        // Le recif est de la roche ; la falaise, du sable dur et sec.
        if (rockMask[c] > 0.5 && depth < 0.25) { mat[i] = MAT_ROCK; pk = 1; mois[i] = 20; }
        else mat[i] = MAT_SAND;
        if (P.cliff && d > P.cliff.at - P.cliff.width && depth < P.cliff.height + 0.3) {
          pk = Math.max(pk, 0.96);
          mois[i] = Math.max(mois[i], 28);
        }
        pack[i] = (pk * 255) | 0;
      }
    }
  }

  field.rebuildAll();
  return { heights, shoreD, noise, style: P.id, seed, scatterPoints: pickScatterPoints(heights, shoreD, P.decor) };
}

/**
 * Silhouette d'un profil de style, pour un croquis : points (d, h) du large
 * a la dune, pas de 20 cm.
 */
export function styleProfilePoints(style) {
  const pts = [];
  for (let d = -(style.foreshore + 1.0); d <= style.face + 3.0; d += 0.2) {
    let h = beachProfile(d, style);
    if (style.bar) {
      const u = (d - style.bar.at) / style.bar.width;
      const g = Math.exp(-(u * u));
      h = Math.min(h + style.bar.height * g, Math.max(h, style.bar.top));
    }
    if (style.cliff) h += style.cliff.height * smoothstep(style.cliff.at - style.cliff.width, style.cliff.at + style.cliff.width, d);
    pts.push({ d, h });
  }
  return pts;
}

/**
 * Choisit les points de dispersion du decor.
 *
 * La plage est zonee comme une vraie plage : herbier profond, recif, platier,
 * sable sous-marin, estran, laisse de mer, haut de plage sec, arriere-dune.
 * Chaque espece n'apparait que dans sa zone, et les coraux poussent en AMAS —
 * un semis regulier se lit immediatement comme du bruit et pas comme un recif.
 *
 * On ne touche pas au champ voxel : ce sont des objets instancies.
 */
function pickScatterPoints(heights, shoreD, decor = {}) {
  const out = {
    shells: [], starfish: [], grass: [], pebbles: [],
    seagrass: [], algae: [], coral: [], brain: [], table: [], fan: [],
    seaRocks: [], urchins: [],
  };
  /** Densite relative d'une espece pour ce style (1 = la plage classique). */
  const mul = (kind) => decor[kind] ?? 1;
  let s = 991;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const at = (wx, wz) => {
    const x = Math.round((wx - ORIGIN_X) / VOXEL - 0.5);
    const z = Math.round((wz - ORIGIN_Z) / VOXEL - 0.5);
    if (x < 1 || z < 1 || x >= NX - 1 || z >= NZ - 1) return null;
    const c = x + NX * z;
    return { d: shoreD[c], y: heights[c] };
  };
  const push = (kind, wx, wz, y, scale) => {
    const f = mul(kind);
    if (f < 1 && rnd() > f) return;
    const arr = out[kind];
    arr.push({ x: wx, y, z: wz, r: rnd() * Math.PI * 2, s: scale });
    // Une espece favorisee par le style pousse en compagnie : des copies
    // decalees de quelques centimetres, jamais un semis plus dense partout.
    for (let extra = f - 1; extra > 0; extra -= 1) {
      if (rnd() > extra) break;
      arr.push({ x: wx + (rnd() - 0.5) * 0.12, y, z: wz + (rnd() - 0.5) * 0.12, r: rnd() * Math.PI * 2, s: scale * (0.85 + rnd() * 0.3) });
    }
  };

  // --- semis uniforme pour tout ce qui ne pousse pas en amas ---------------
  for (let n = 0; n < 26000; n++) {
    const wx = ORIGIN_X + rnd() * NX * VOXEL;
    const wz = ORIGIN_Z + rnd() * NZ * VOXEL;
    const p = at(wx, wz);
    if (!p) continue;
    const { d, y } = p;

    if (d < -3.2) {
      // Fond du large : du sable clair, c'est lui qui fait le turquoise. Les
      // herbiers y poussent en TACHES (voir plus bas), jamais en tapis : un
      // tapis continu se lit comme une pelouse et eteint la couleur de l'eau.
      if (rnd() < 0.025) push('seagrass', wx, wz, y, 0.7 + rnd() * 0.5);
      else if (rnd() < 0.02) push('algae', wx, wz, y, 0.8 + rnd() * 0.5);
      else if (rnd() < 0.006) push('fan', wx, wz, y, 0.75 + rnd() * 0.5);
      else if (rnd() < 0.006) push('seaRocks', wx, wz, y, 0.7 + rnd() * 0.7);
    } else if (d < -2.4) {
      // Recif : le corail arrive par amas, ici on ne seme que l'accompagnement.
      if (rnd() < 0.04) push('seagrass', wx, wz, y, 0.7 + rnd() * 0.5);
      else if (rnd() < 0.04) push('urchins', wx, wz, y, 0.8 + rnd() * 0.5);
      else if (rnd() < 0.03) push('seaRocks', wx, wz, y, 0.7 + rnd() * 0.7);
    } else if (d < -1.9) {
      // Platier
      if (rnd() < 0.07) push('algae', wx, wz, y, 0.7 + rnd() * 0.5);
      else if (rnd() < 0.02) push('seagrass', wx, wz, y, 0.6 + rnd() * 0.4);
      else if (rnd() < 0.012) push('brain', wx, wz, y, 0.6 + rnd() * 0.5);
    } else if (d < -1.2) {
      // Sable sous-marin : clairseme, on voit surtout le fond.
      if (rnd() < 0.006) push('seagrass', wx, wz, y, 0.5 + rnd() * 0.4);
      else if (rnd() < 0.012) push('starfish', wx, wz, y, 0.6 + rnd() * 0.35);
      else if (rnd() < 0.02) push('shells', wx, wz, y, 0.8 + rnd() * 0.5);
    } else if (d < 2.2) {
      // Estran
      if (rnd() < 0.012) push('shells', wx, wz, y, 0.7 + rnd() * 0.5);
      else if (rnd() < 0.006) push('pebbles', wx, wz, y, 0.7 + rnd() * 0.6);
    } else if (d < 3.2) {
      // Laisse de mer : le cordon de coquillages.
      if (rnd() < 0.09) push('shells', wx, wz, y, 0.7 + rnd() * 0.6);
      else if (rnd() < 0.004) push('starfish', wx, wz, y, 0.55 + rnd() * 0.3);
    } else if (d < 5.2) {
      if (rnd() < 0.012) push('pebbles', wx, wz, y, 0.7 + rnd() * 0.6);
      else if (rnd() < 0.004) push('shells', wx, wz, y, 0.7 + rnd() * 0.4);
    } else {
      // Arriere-dune
      if (rnd() < 0.018) push('grass', wx, wz, y, 0.75 + rnd() * 0.6);
      else if (rnd() < 0.008) push('pebbles', wx, wz, y, 0.7 + rnd() * 0.5);
    }
  }

  // --- herbiers en taches (processus de Neyman-Scott) -----------------------
  // Un herbier de posidonie ou de zostere forme des mattes sombres aux bords
  // nets sur le sable clair : c'est ce contraste taches sombres / sable blanc
  // qui donne a un lagon sa lecture aerienne.
  for (let c = 0; c < 34; c++) {
    let cx = 0, cz = 0, ok = false;
    for (let tries = 0; tries < 60 && !ok; tries++) {
      cx = ORIGIN_X + rnd() * NX * VOXEL;
      cz = ORIGIN_Z + rnd() * NZ * VOXEL;
      const p = at(cx, cz);
      ok = p && p.d < -1.7;
    }
    if (!ok) continue;
    const rx = 0.35 + rnd() * 0.9, rz = 0.35 + rnd() * 0.9;
    const n = 18 + Math.floor(rnd() * 40);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      const wx = cx + Math.cos(a) * r * rx, wz = cz + Math.sin(a) * r * rz;
      const p = at(wx, wz);
      if (!p || p.d > -1.5) continue;
      if (rnd() < 0.85) push('seagrass', wx, wz, p.y, 0.75 + rnd() * 0.6);
      else push('algae', wx, wz, p.y, 0.7 + rnd() * 0.5);
    }
  }

  // --- amas de corail (processus de Neyman-Scott) --------------------------
  // On tire des centres de massif, puis on disperse les colonies autour : un
  // recif est fait de tetes de corail groupees, pas d'un semis regulier.
  for (let c = 0; c < 26; c++) {
    let cx = 0, cz = 0, ok = false;
    for (let tries = 0; tries < 60 && !ok; tries++) {
      cx = ORIGIN_X + rnd() * NX * VOXEL;
      cz = ORIGIN_Z + rnd() * NZ * VOXEL;
      const p = at(cx, cz);
      ok = p && p.d < -2.2 && p.d > -4.6;
    }
    if (!ok) continue;
    const spread = 0.35 + rnd() * 0.55;
    const n = 6 + Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = spread * Math.sqrt(rnd());
      const wx = cx + Math.cos(a) * r, wz = cz + Math.sin(a) * r;
      const p = at(wx, wz);
      if (!p || p.d > -1.9) continue;
      const roll = rnd();
      if (roll < 0.58) push('coral', wx, wz, p.y, 0.7 + rnd() * 0.7);
      else if (roll < 0.76) push('brain', wx, wz, p.y, 0.7 + rnd() * 0.6);
      else if (roll < 0.88) push('table', wx, wz, p.y, 0.7 + rnd() * 0.5);
      else push('fan', wx, wz, p.y, 0.7 + rnd() * 0.5);
    }
  }
  return out;
}
