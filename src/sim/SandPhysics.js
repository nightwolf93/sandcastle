/**
 * Modele materiau du sable.
 *
 * Tout part de deux champs par voxel :
 *   w = saturation (fraction du volume des pores occupee par l'eau, 0..1)
 *   p = compaction (0 = sable verse en vrac, 1 = pound-up de competition)
 *
 * Le sable humide tient parce que l'eau forme des PONTS CAPILLAIRES entre les
 * grains : la tension de surface tire les grains l'un vers l'autre et cree une
 * "cohesion apparente" c. Quelques pourcents d'eau suffisent — c'est le regime
 * pendulaire. Quand les pores se remplissent (regime capillaire puis sature),
 * les ponts fusionnent, la succion disparait et le sable se liquefie.
 *
 * Angle de stabilite maximal :
 *   theta_max(w, p) = theta_res(w) + (89 - theta_res(w)) * f_coh(w) * f_pack(p)
 *   f_coh(w)  = (1 - exp(-w / 0.03)) * (1 - smoothstep(0.25, 0.90, w))
 *   theta_res(w) = 34 - 19 * smoothstep(0.75, 1.0, w)   (liquefaction)
 *   f_pack(p) = 0.72 + 0.28 * p^0.8
 *
 * Valeurs obtenues (deg) :
 *   w=0     34.0    sable sec, angle de repos pur frottement
 *   w=0.02  60.8
 *   w=0.05  81.7
 *   w=0.10  86.2
 *   w=0.15  87.5    plateau : murs verticaux possibles
 *   w=0.30  84.8
 *   w=0.50  70.8
 *   w=0.80  35.5
 *   w=1.00  15.0    coule comme une boue
 *
 * Critere de rupture sous-jacent : Mohr-Coulomb  tau_max = c + sigma_n tan(phi)
 */

import {
  VOXEL as VOXEL_SIZE,
  PHI_FRICTION,
  COHESION_MAX,
  W_OPTIMAL,
  W_SATURATED,
  RHO_SAND_LOOSE,
  RHO_SAND_PACKED,
  POROSITY,
  GRAVITY,
  RESIDUAL_SATURATION,
  clamp,
  smoothstep,
} from '../core/Config.js';

const DEG2RAD = Math.PI / 180;
export const THETA_MAX_DEG = 89;
export const THETA_DRY_DEG = 34;

// --- fonctions analytiques --------------------------------------------------

/** Facteur de cohesion capillaire, 0..1. Monte en quelques pourcents d'eau. */
export function cohesionFactor(w) {
  if (w <= 0) return 0;
  const rise = 1 - Math.exp(-w / 0.03);
  const drown = 1 - smoothstep(0.25, 0.9, w);
  return rise * drown;
}

/** Angle de repos residuel : chute a l'approche de la liquefaction. */
export function residualAngle(w) {
  return THETA_DRY_DEG - 19 * smoothstep(0.75, 1.0, w);
}

/**
 * Effet du tassement sur la COHESION. Super-lineaire : damer augmente a la
 * fois le nombre de ponts capillaires et la force de chacun (gain x4 a x10,
 * pas x1.25).
 */
export function packFactor(p) {
  return 0.15 + 0.85 * Math.pow(clamp(p, 0, 1), 1.5);
}

/**
 * Effet du tassement sur l'ANGLE de stabilite. Beaucoup plus doux que sur la
 * cohesion : meme du sable humide verse en vrac tient deja une pente raide,
 * c'est la tenue des surplombs et des murs hauts qui depend vraiment du damage.
 */
export function packAngleFactor(p) {
  return 0.72 + 0.28 * Math.pow(clamp(p, 0, 1), 0.8);
}

/** Angle de stabilite maximal, en degres. */
export function thetaMax(w, p = 0.5) {
  const res = residualAngle(w);
  return res + (THETA_MAX_DEG - res) * cohesionFactor(w) * packAngleFactor(p);
}

// --- STABILITE DES TALUS : angle OU hauteur, pas angle seul -----------------
//
// C'est le point le plus important de tout le modele, et le plus facile a
// rater. Un premier jet utilisait l'angle de repos comme limite absolue : des
// qu'une pente locale depassait theta_max, du sable coulait. C'est juste pour
// un materiau SANS COHESION — un tas de sable sec ne peut effectivement pas
// depasser 34 degres, quelle que soit sa taille.
//
// Mais du sable HUMIDE est un materiau cohesif, et un materiau cohesif tient
// une face verticale. Ce qui le limite n'est pas un angle, c'est une HAUTEUR :
// la hauteur critique de Culmann.
//
//     H_c(beta) = (4 c / gamma) * sin(beta) * cos(phi) / (1 - cos(beta - phi))
//
//   beta  = angle de la face
//   phi   = angle de frottement interne
//   c     = cohesion apparente (les ponts capillaires)
//   gamma = poids volumique
//
// Quand beta tend vers phi, H_c tend vers l'infini : sous l'angle de
// frottement, n'importe quelle hauteur tient. A 90 degres, H_c se reduit a
// (4c/gamma)*tan(45 + phi/2).
//
// Consequences, et elles sautent aux yeux en jeu :
//   - sable sec (c = 0)          -> H_c = 0 : tout s'affaisse a 34 degres ;
//   - sable a peine humide (3 %) -> paroi verticale stable sur ~42 cm, donc un
//     seau demoule TIENT, et on peut y creuser une fenetre ;
//   - sable parfait bien dame    -> ~90 cm de mur vertical ;
//   - au-dela, ca cede — et ca cede par le HAUT, comme dans la realite.
//
// On precalcule donc, pour chaque couple (humidite, compaction), la
// denivellation locale maximale tenable, exprimee en voxels. Le test dans la
// boucle chaude reste une simple lecture de table.

const WN = 256;
const PN = 16;

/**
 * Denivellation maximale stable, en voxels, mesuree sur une base de 1 voxel.
 * C'est le test de proximite : il attrape les pentes trop raides.
 */
export const MAX_DROP_LUT = new Float32Array(WN * PN);
/**
 * Idem, mais sur une base de FAR_BASE voxels.
 *
 * Ce second test est indispensable. Avec le seul test de proximite, un mur
 * peut monter indefiniment EN MARCHES : chaque decrochement d'un voxel
 * "recharge" le budget de hauteur, et un mur de 1,20 m en sable a peine humide
 * se contentait de s'eroder de deux voxels sur les bords avant de se declarer
 * stable. Le critere de Culmann porte sur la FACE entiere, pas sur chacune de
 * ses marches : il faut donc aussi mesurer la denivellation sur une base plus
 * large.
 */
export const MAX_DROP_FAR_LUT = new Float32Array(WN * PN);

/** Base large du second test, en voxels (24 cm). */
export const FAR_BASE = 6;
/** Hauteur critique d'une face verticale, en metres (interface et debug). */
export const HCRIT_LUT = new Float32Array(WN * PN);
/** theta_max en degres, conserve pour l'interface. */
export const THETA_LUT = new Float32Array(WN * PN);
/** Cohesion apparente normalisee 0..1, indexee par w uniquement. */
export const COHESION_LUT = new Float32Array(WN);

/**
 * Plafond de la table. Doit rester superieur a la denivellation maximale que
 * la regle de pente sait mesurer (KMAX voxels), sinon une paroi parfaitement
 * stable depasserait quand meme le seuil et s'eroderait par les aretes.
 */
export const DROP_CAP = 40;

/** Hauteur critique de Culmann pour une face d'angle beta (radians). */
export function culmannHeight(beta, c, gamma, phiRad) {
  if (c <= 0 || gamma <= 0) return 0;
  if (beta <= phiRad + 1e-4) return Infinity; // sous l'angle de frottement
  const den = 1 - Math.cos(beta - phiRad);
  if (den < 1e-6) return Infinity;
  return ((4 * c) / gamma) * ((Math.sin(beta) * Math.cos(phiRad)) / den);
}

/**
 * Denivellation locale maximale tenable, en voxels, pour un sable donne.
 * Resolue par dichotomie : on cherche la plus grande face qui satisfasse
 * encore le critere de Culmann.
 */
export function maxStableDrop(w, p, base = 1, voxel = VOXEL_SIZE) {
  const phiRad = residualAngle(w) * DEG2RAD;
  const tanPhi = Math.tan(phiRad);
  const c = cohesion(w, p);
  const gamma = density(w, p) * GRAVITY;
  // Sans cohesion : seul l'angle de repos compte, quelle que soit la base.
  if (c < 1) return tanPhi * base;
  const cap = DROP_CAP * base;
  // La face fait `drop` voxels de haut pour `base` voxels de large.
  const stable = (drop) =>
    drop * voxel <= culmannHeight(Math.atan(drop / base), c, gamma, phiRad);
  if (stable(cap)) return cap;
  let lo = tanPhi * base, hi = cap;
  for (let i = 0; i < 34; i++) {
    const mid = (lo + hi) * 0.5;
    if (stable(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

for (let pi = 0; pi < PN; pi++) {
  const p = pi / (PN - 1);
  for (let wi = 0; wi < WN; wi++) {
    const w = wi / (WN - 1);
    const o = pi * WN + wi;
    THETA_LUT[o] = thetaMax(w, p);
    MAX_DROP_LUT[o] = maxStableDrop(w, p, 1);
    MAX_DROP_FAR_LUT[o] = maxStableDrop(w, p, FAR_BASE);
    const phiRad = residualAngle(w) * DEG2RAD;
    const hc = culmannHeight(Math.PI / 2, cohesion(w, p), density(w, p) * GRAVITY, phiRad);
    HCRIT_LUT[o] = Number.isFinite(hc) ? hc : 99;
  }
}
for (let wi = 0; wi < WN; wi++) {
  COHESION_LUT[wi] = cohesionFactor(wi / (WN - 1));
}

/**
 * Lecture rapide dans la table depuis les octets stockes dans le champ voxel.
 * @param {number} m humidite 0..255
 * @param {number} pk compaction 0..255
 * @returns {number} denivellation locale maximale stable, en voxels
 */
export function maxDropByte(m, pk) {
  return MAX_DROP_LUT[((pk >> 4) << 8) + m];
}

/** Denivellation maximale tenable mesuree sur FAR_BASE voxels. */
export function maxDropFarByte(m, pk) {
  return MAX_DROP_FAR_LUT[((pk >> 4) << 8) + m];
}

export function thetaByte(m, pk) {
  return THETA_LUT[((pk >> 4) << 8) + m];
}

/** Hauteur critique d'un mur vertical, en metres. */
export function hcritByte(m, pk) {
  return HCRIT_LUT[((pk >> 4) << 8) + m];
}

// --- grandeurs derivees -----------------------------------------------------

/** Cohesion apparente en Pa. */
export function cohesion(w, p = 0) {
  return cohesionFactor(w) * packFactor(p) * COHESION_MAX;
}

/** Masse volumique apparente (kg/m3). */
export function density(w, p = 0) {
  const dry = RHO_SAND_LOOSE + (RHO_SAND_PACKED - RHO_SAND_LOOSE) * clamp(p, 0, 1);
  return dry + w * POROSITY * 1000;
}

export const TAN_PHI = Math.tan(PHI_FRICTION * DEG2RAD);

/**
 * Hauteur critique d'un mur vertical (Culmann) :
 *   H_c = (4 c / gamma) * tan(45 + phi/2)
 * Avec c = 2400 Pa et du sable tasse on obtient ~1.1 m, ce qui colle a ce que
 * les sculpteurs obtiennent reellement en pound-up.
 */
export function criticalWallHeight(w, p) {
  const c = cohesion(w, p);
  const gamma = density(w, p) * GRAVITY;
  if (gamma <= 0) return 0;
  return (4 * c / gamma) * Math.tan((45 + PHI_FRICTION / 2) * DEG2RAD);
}

/**
 * Longueur de porte-a-faux tenable, en metres. Modele de poutre encastree :
 * la contrainte de traction en pied vaut 3 rho g L^2 / t.
 * @param {number} t epaisseur de la dalle en surplomb (m)
 * @param {number} load charge verticale au-dessus (0..1) — la compression
 *   augmente la cohesion des grains (arches de gres) : un surplomb charge
 *   tient MIEUX qu'un surplomb allege.
 */
export function maxOverhang(w, p, t = 0.12, load = 0) {
  const c = cohesion(w, p) * (1 + 0.55 * clamp(load, 0, 1));
  if (c <= 5) return 0;
  const sigmaT = c * 0.55;
  const rho = density(w, p);
  // Le modele de poutre encastree seul est trop conservateur : le sable
  // travaille aussi en voute et la "dalle" n'est pas une poutre mince. Le
  // facteur K recale le resultat sur ce qu'on observe reellement, soit
  // 12 a 16 cm de porte-a-faux en sable parfait bien dame.
  const K = 3.1;
  return Math.min(K * Math.sqrt((sigmaT * Math.max(t, 0.02)) / (3 * rho * GRAVITY)), 0.9);
}

/**
 * Loi d'echelle des tours : H_max proportionnel a R^(2/3).
 * Calibree pour qu'une tour de 12 cm de rayon en sable parfait tienne ~45 cm.
 */
export function maxTowerHeight(radius, w, p) {
  const k = criticalWallHeight(w, p) * 1.15;
  return k * Math.pow(Math.max(radius, 0.02) / 0.12, 2 / 3);
}

// --- lecture pour l'interface -----------------------------------------------

/**
 * Categorie lisible (panneau "Sable"). Le joueur ne doit jamais lire un
 * pourcentage : il lit une couleur, un mot et un conseil.
 */
export function moistureCategory(w) {
  if (w < 0.012) return { key: 'dry', label: 'Sable sec', hint: 'Il coule entre les doigts' };
  if (w < 0.035) return { key: 'damp', label: 'Sable frais', hint: 'Commence tout juste a tenir' };
  if (w < 0.07) return { key: 'moist', label: 'Sable humide', hint: 'Bonne tenue' };
  if (w < 0.22) return { key: 'perfect', label: 'Sable parfait', hint: 'Tenue maximale — sculpte !' };
  if (w < 0.4) return { key: 'wet', label: 'Sable mouille', hint: 'Lourd, un peu mou' };
  if (w < 0.65) return { key: 'soaked', label: 'Sable trempe', hint: 'Il s affaisse sous son poids' };
  return { key: 'liquid', label: 'Sable liquide', hint: 'Ideal pour les tours gouttes' };
}

export function packingCategory(p) {
  if (p < 0.2) return { label: 'En vrac', hint: 'Sable verse, jamais tasse' };
  if (p < 0.45) return { label: 'Tasse', hint: 'Quelques passages de main' };
  if (p < 0.72) return { label: 'Bien dame', hint: 'Solide' };
  return { label: 'Pound-up', hint: 'Compaction de competition' };
}

/**
 * Qualite de demoulage d'un seau ou d'une forme, 0..1.
 * Trop sec : le sable s effondre a la sortie. Trop mouille : ca s affaisse.
 */
export function demouldQuality(w, p) {
  const wq = Math.exp(-Math.pow((w - 0.14) / 0.10, 2));
  return clamp(wq * (0.4 + 0.6 * packFactor(p)), 0, 1);
}

/**
 * Humidite qui reste dans le sable quand le seau a ete retourne et tapote.
 *
 * `w` est la saturation des pores, pas simplement la quantite d'eau visible.
 * Au-dessus d'environ 18 %, une grande partie est de l'eau libre : elle
 * s'egoutte par l'ouverture pendant les phases flip/lower/tap. L'ancien outil
 * stampait la saturation brute et transformait donc le sable pris pres de la
 * nappe en galette, alors que le geste meme du demoulage l'avait deja draine.
 */
export function bucketMoistureAfterDrain(w) {
  const raw = clamp(w, 0, 1);
  const retained = 0.18;
  return raw <= retained ? raw : retained + (raw - retained) * 0.09;
}

/**
 * Etat materiau et forme d'un demoulage apres egouttage et tapotement.
 * La qualite physique `q` decide encore de l'issue, mais la qualite de FORME
 * est remappee : une issue annoncee « clean » doit ressembler a un seau, pas
 * perdre 20 % de sa hauteur et onduler de 15 %.
 */
export function bucketDemouldState(rawMoisture, packing) {
  const raw = clamp(rawMoisture, 0, 1);
  const pack = clamp(packing, 0, 1);
  const moisture = bucketMoistureAfterDrain(raw);
  const q = demouldQuality(moisture, pack);
  const dry = RESIDUAL_SATURATION + 0.005;

  let outcome;
  if (raw < dry) outcome = 'stuck';
  else if (raw >= 0.90 || q < 0.22) outcome = 'collapse';
  else if (q >= 0.50) outcome = 'clean';
  else outcome = 'slump';

  let shapeQuality = 0;
  if (outcome === 'clean') {
    shapeQuality = 0.94 + 0.06 * clamp((q - 0.50) / 0.50, 0, 1);
  } else if (outcome === 'slump') {
    shapeQuality = 0.72 + 0.18 * clamp((q - 0.22) / 0.28, 0, 1);
  } else if (outcome === 'collapse') {
    shapeQuality = 0.35;
  }

  return {
    outcome,
    q,
    shapeQuality,
    rawMoisture: raw,
    moisture,
    drained: raw - moisture,
    packing: pack,
  };
}

export { W_OPTIMAL, W_SATURATED };
