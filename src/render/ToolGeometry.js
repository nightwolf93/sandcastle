/**
 * Fabrique de geometries d'outils — le bac a jouets de plage.
 *
 * Tout est genere en code, dans le style de `Props.js` : aucun fichier
 * d'asset. Les formes sont dessinees pour etre lues a 18 pixels de haut (la
 * taille d'un seau de 15 cm a la distance de travail par defaut), ce qui
 * gouverne trois choix :
 *
 *   - la SILHOUETTE porte toute l'information : coupure blanc/rouge sur les
 *     manches, poignee en D bien ouverte, anse detachee du corps ;
 *   - la RUGOSITE fait le reste : 0,34 (polypropylene injecte), donc un point
 *     de speculaire qui bouge quand la camera tourne. A cette taille, ce point
 *     vaut dix fois la geometrie ;
 *   - le BUDGET est ridicule (< 500 triangles pour l'outil tenu) parce que le
 *     terrain en fait 200 000.
 */

import * as THREE from 'three';
import { mergeGeoms, mulberry, makeArc } from './GeoUtils.js';

/**
 * Plastique moule.
 *
 * `metalness: 0` partout : l'erreur classique est d'ajouter « un peu de
 * metalness pour la brillance », ce qui noircit le plastique.
 *
 * `emissive = couleur x 0.05` : un jouet reel garde sa couleur a l'ombre,
 * parce que le pigment est dans la masse et que le materiau diffuse un peu
 * sous la surface. Sans cette triche a trois lignes, un seau jaune place a
 * l'ombre dans un rendu PBR avec ciel bleu vire au gris-bleu et perd son
 * identite. C'est aussi ce qui rend `emissiveIntensity` utilisable pour la
 * surbrillance de survol des outils poses (§7.7).
 */
const PLASTIC = (hex, rough = 0.34) => {
  const c = new THREE.Color(hex);
  return new THREE.MeshStandardMaterial({
    color: c,
    roughness: rough,
    metalness: 0.0,
    emissive: c.clone().multiplyScalar(0.05),
  });
};

/** Les six couleurs du bac a jouets. Ne pas en ajouter une septieme. */
export const TOY = {
  red: 0xe0341f,    // pelle, rateau — la couleur des captures de reference
  blue: 0x1f6fd0,   // arrosoir, seau d'eau
  yellow: 0xf2b21f, // seau a demouler
  green: 0x33a05a,  // truelle
  white: 0xf2efe7,  // manches
  grey: 0x8e959c,   // pieces metalliques
};

export const TOOL_MATERIALS = {
  red: () => PLASTIC(TOY.red),
  blue: () => PLASTIC(TOY.blue),
  yellow: () => PLASTIC(TOY.yellow),
  green: () => PLASTIC(TOY.green),
  // La lame de la pelle est une NAPPE, pas un solide : une lame pleine
  // couterait le double pour rien a 18 px. Il faut donc la voir des deux
  // cotes — de dessus quand elle est chargee, de dessous quand elle se vide.
  redThin: () => {
    const m = PLASTIC(TOY.red);
    m.side = THREE.DoubleSide;
    return m;
  },
  // Le manche : blanc casse, un peu plus mat (il est granuleux au toucher).
  handle: () => PLASTIC(TOY.white, 0.46),
  // Le metal des mirettes et des anses : la seule metalness du jeu.
  metal: () => new THREE.MeshStandardMaterial({
    color: 0xb9bec4, roughness: 0.30, metalness: 0.75, emissive: 0x0a0b0c,
  }),
  wood: () => new THREE.MeshStandardMaterial({
    color: 0xb98a4e, roughness: 0.78, metalness: 0.0, emissive: 0x0e0a06,
  }),
  // Le sable CONTENU dans un outil. Plus fonce que le sable du sol : c'est du
  // sable travaille, donc humide et tasse.
  sandWet: () => new THREE.MeshStandardMaterial({
    color: 0x9c8560, roughness: 0.95, metalness: 0.0,
    emissive: 0x0c0a07, side: THREE.DoubleSide,
  }),
  water: () => new THREE.MeshStandardMaterial({
    color: 0x4fa3d8, roughness: 0.15, metalness: 0.0,
    emissive: 0x04080b, transparent: true, opacity: 0.72,
  }),
};

// ---------------------------------------------------------------------------
// LE SEAU
// ---------------------------------------------------------------------------

/**
 * Proportion hauteur / rayon de bouche. Un seau de plage reel vaut ~1,9.
 *
 * CONSTANTE PARTAGEE : `tools.js` s'en sert pour calculer la capacite du seau
 * et la hauteur de la tour demoulee. Si les deux valeurs divergent, le seau se
 * remplit « a moitie » quand il est plein a l'ecran et toute l'illusion meurt.
 */
export const BUCKET_ASPECT = 2.0;

/** Epaisseur de paroi, en fraction du rayon de bouche. */
const WALL = 0.055;
const LATHE_SEG = 16;

/** Rayon du fond, en fraction du rayon de bouche. Doit valoir `rTop / rBottom`
 *  de `Brush.stampBucket` : la tour est large en bas, retrecie en haut. */
export const BUCKET_TAPER = 0.86;

/**
 * Seau de plage, construit a rayon de BOUCHE unitaire : le rig le met a
 * l'echelle par le rayon de brosse, ce qui garantit que le seau VU correspond
 * exactement au volume STAMPE.
 *
 * Le profil part du centre du fond, remonte la paroi exterieure, passe le
 * bourrelet, redescend la paroi interieure et revient au centre : une seule
 * revolution produit une coque fermee d'epaisseur constante. Une paroi
 * d'epaisseur zero se trahit immediatement (bord infiniment fin, face arriere
 * noire).
 */
export function makeBucketGeometry() {
  const H = BUCKET_ASPECT;
  const RB = BUCKET_TAPER;
  const RT = 1.0;
  const w = WALL;

  const P = (x, y) => new THREE.Vector2(x, y);
  const profile = [
    P(0.0, 0.0),                     // centre du fond (exterieur)
    P(RB * 0.72, 0.0),
    P(RB, 0.035 * H),                // conge du fond
    P(RT, H - 0.05 * H),             // paroi exterieure, legerement conique
    P(RT + w * 0.9, H - 0.012 * H),  // bourrelet, qui deborde vers l'exterieur
    P(RT + w * 0.5, H),              // levre
    P(RT - w, H - 0.02 * H),         // retour interieur
    P(RB - w, 0.05 * H),             // paroi interieure
    P(RB * 0.7 - w, w),              // conge interieur
    P(0.0, w),                       // centre du fond (interieur)
  ];

  const shell = new THREE.LatheGeometry(profile, LATHE_SEG);

  // Anse : arceau qui part de deux tetons sous la levre.
  const handle = makeArc(RT * 1.02, w * 0.55, 0.08, Math.PI - 0.08, 10);
  handle.translate(0, H - 0.09 * H, 0);

  return { shell, handle, height: H, rBottom: RB, rTop: RT, wall: w };
}

/**
 * Surface de sable a l'interieur du seau — le coeur de la demande du joueur :
 * le seau doit se remplir VISIBLEMENT.
 *
 * Grille cylindrique de (RING+1) x SEG sommets plus un sommet central, allouee
 * UNE SEULE FOIS ; `setLevel` reecrit les positions en place. Aucune
 * allocation en jeu, aucune recreation de BufferGeometry, et le rayon suit
 * exactement le tronc de cone a la hauteur atteinte — ce qu'un simple
 * `scale.y` ne saurait pas faire.
 *
 * @returns {{geometry: THREE.BufferGeometry, setLevel: Function}}
 */
export function makeBucketSand(SEG = 16, RING = 3) {
  const rows = RING + 1;
  const vertCount = rows * SEG + 1;
  const center = rows * SEG;

  const pos = new Float32Array(vertCount * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const idx = [];
  for (let r = 0; r < RING; r++) {
    for (let c = 0; c < SEG; c++) {
      const a = r * SEG + c, b = r * SEG + ((c + 1) % SEG);
      const a2 = (r + 1) * SEG + c, b2 = (r + 1) * SEG + ((c + 1) % SEG);
      idx.push(a, a2, b2, a, b2, b);
    }
  }
  for (let c = 0; c < SEG; c++) {
    idx.push(RING * SEG + c, center, RING * SEG + ((c + 1) % SEG));
  }
  geo.setIndex(idx);

  // Bruit fige : le dessus du sable n'est jamais parfaitement lisse.
  const rnd = mulberry(1337);
  const bump = new Float32Array(SEG);
  for (let c = 0; c < SEG; c++) bump[c] = (rnd() - 0.5) * 2;

  /**
   * @param {number} fill    0..1
   * @param {number} wobble  0..1 — desordre du dessus (sable frais = 1, arase
   *                         apres tapotage = 0). C'est la traduction visuelle
   *                         des etapes « tasser, vibrer, araser » de la Bible.
   * @param {object} B       la description renvoyee par makeBucketGeometry()
   * @param {boolean} flipped seau retourne : le sable se tasse contre la
   *                         BOUCHE et non contre le fond.
   */
  function setLevel(fill, wobble, B, flipped = false) {
    const f = Math.max(0.0001, Math.min(1, fill));
    const innerAt = (y) => {
      const t = Math.max(0, Math.min(1, y / B.height));
      return (B.rBottom - B.wall) + ((B.rTop - B.wall) - (B.rBottom - B.wall)) * t;
    };
    // yBase : la paroi contre laquelle le sable repose. ySurf : la surface libre.
    const yBottom = B.wall * 1.05;
    const yBase = flipped ? B.height : yBottom;
    const ySurf = flipped
      ? B.height - (B.height - yBottom) * f
      : yBottom + (B.height - yBottom) * f;
    const sign = flipped ? -1 : 1;
    // Bombement : le sable verse forme un petit cone (angle de repos).
    const dome = 0.10 * B.rTop * wobble * sign;

    for (let r = 0; r <= RING; r++) {
      const t = r / RING;
      const y = yBase + (ySurf - yBase) * t;
      const R = innerAt(y) * (r === RING ? 0.995 : 1.0);
      for (let c = 0; c < SEG; c++) {
        const a = (c / SEG) * Math.PI * 2;
        const i = (r * SEG + c) * 3;
        const irregular = r === RING ? 1 + 0.045 * wobble * bump[c] : 1;
        pos[i] = Math.cos(a) * R * irregular;
        pos[i + 1] = y + (r === RING ? 0.02 * dome * bump[c] : 0);
        pos[i + 2] = Math.sin(a) * R * irregular;
      }
    }
    pos[center * 3] = 0;
    pos[center * 3 + 1] = ySurf + dome;
    pos[center * 3 + 2] = 0;

    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  setLevel(0.5, 1, { height: BUCKET_ASPECT, rBottom: BUCKET_TAPER, rTop: 1, wall: WALL });
  return { geometry: geo, setLevel };
}

// ---------------------------------------------------------------------------
// LA PELLE
// ---------------------------------------------------------------------------

/**
 * Cuillere / creux : grille (N+1)x(N+1) projetee sur un paraboloide tronque,
 * avec un rebord releve. Reutilisee par la pelle et la dame.
 */
function makeScoop(halfW, len, depth, N = 4) {
  const pos = [];
  const P = (u, v) => {
    // u : -1..1 en largeur, v : 0..1 en longueur (0 = talon, 1 = pointe)
    const taper = 1 - 0.42 * v * v;
    const x = u * halfW * taper;
    const z = (v - 0.5) * len;
    // Creux : plus profond au talon, nul a la pointe. Le bord se releve.
    const y = -depth * (1 - v) * (1 - u * u) + depth * 0.35 * u * u * (1 - v);
    return [x, y, z];
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u0 = -1 + (2 * i) / N, u1 = -1 + (2 * (i + 1)) / N;
      const v0 = j / N, v1 = (j + 1) / N;
      const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
      // Ordre a -> d -> c : les normales sortent VERS LE HAUT, du cote creux.
      // Avec l'ordre direct (a, b, c) elles pointaient vers le bas et la lame
      // de la pelle etait purement et simplement invisible, back-face culled —
      // on ne voyait qu'un manche blanc flottant au-dessus du sable.
      pos.push(...a, ...d, ...c, ...a, ...c, ...b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Pelle de plage : manche + poignee en D + lame creuse.
 *
 * Deux geometries separees (rouge / blanc) : la coupure de silhouette
 * blanc-manche / rouge-lame est exactement ce qui rend la pelle lisible a
 * 18 px, et c'est le code visuel du jouet de plage.
 *
 * L'origine est au collier (jonction manche-lame), la pointe de la lame vers
 * -Y et +Z : c'est le POINT DE TRAVAIL, celui qu'on fait coincider avec le
 * point vise.
 */
export function makeShovelGeometry() {
  const L = 0.44;
  const white = [];
  const red = [];

  const shaft = new THREE.CylinderGeometry(0.011, 0.013, L, 6, 1, true);
  shaft.translate(0, L * 0.5, 0);
  white.push(shaft);

  // Poignee en D : un arc dans le plan du manche. Silhouette immediate.
  const d = makeArc(0.036, 0.007, -0.25, Math.PI + 0.25, 9);
  d.rotateY(Math.PI / 2);
  d.translate(0, L + 0.030, 0);
  red.push(d);

  const collar = new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6, 1, true);
  collar.translate(0, 0.02, 0);
  red.push(collar);

  // Large et peu creuse : a cette taille, une lame trop bombee se lit comme
  // un ruban et non comme une pelle. C'est la LARGEUR qui fait la silhouette.
  const blade = makeScoop(0.088, 0.125, 0.020);
  blade.rotateX(-0.22);            // la lame « ouvre » vers l'avant
  blade.translate(0, -0.055, 0.012);
  red.push(blade);

  return { red: mergeGeoms(red), white: mergeGeoms(white), length: L };
}

/**
 * Pelletee : demi-ellipsoide aplati pose dans le creux de la lame.
 * `carried.volume` existait deja et n'avait AUCUNE representation visuelle :
 * un etat invisible est un bug pour le joueur.
 */
export function makeShovelLoad() {
  const g = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Bosse figee : ca doit ressembler a un tas, pas a un dome de cathedrale.
    const n = 0.9 + 0.18 * Math.sin(x * 23) * Math.cos(z * 19);
    // Volontairement plus PLATE et plus COURTE que le creux de la lame : une
    // calotte qui deborde masque la lame rouge, et on perd la silhouette de
    // pelle — c'est-a-dire tout ce qui permet de reconnaitre l'outil.
    p.setXYZ(i, x * 0.058 * n, y * 0.021 * n, z * 0.082 * n);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// LES AUTRES
// ---------------------------------------------------------------------------

/**
 * Arrosoir : corps par revolution, anse en pont, goulot incline, pomme.
 * Les trous de la pomme ne sont pas modelises : a 18 px on ne les verrait pas
 * et ils couteraient 200 triangles.
 */
export function makeWateringCanGeometry() {
  const H = 0.20, R = 0.085;
  const P = (x, y) => new THREE.Vector2(x, y);
  const body = new THREE.LatheGeometry([
    P(0, 0), P(R * 0.85, 0), P(R, 0.03),
    P(R * 0.98, H * 0.72), P(R * 0.80, H * 0.93),
    P(R * 0.62, H), P(R * 0.58, H - 0.012),
    P(0, H - 0.012),
  ], 14);

  const parts = [];
  const handle = makeArc(R * 0.9, 0.006, 0.35, Math.PI - 0.35, 8);
  handle.rotateY(Math.PI / 2);
  handle.translate(0, H * 0.80, -R * 0.25);
  parts.push(handle);

  const spout = new THREE.CylinderGeometry(0.011, 0.016, 0.19, 6, 1, true);
  spout.rotateX(-0.62);
  spout.translate(0, H * 0.52, R * 0.72);
  parts.push(spout);

  const rose = new THREE.SphereGeometry(0.028, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.42);
  rose.scale(1, 0.55, 1);
  rose.rotateX(-0.62 + Math.PI * 0.5);
  rose.translate(0, H * 0.52 + 0.088, R * 0.72 + 0.055);
  parts.push(rose);

  return { body, rest: mergeGeoms(parts), height: H, radius: R };
}

/**
 * Truelle langue-de-chat (Bible §3.3.1 : Marshalltown 7" x 3").
 * Lame triangulaire biseautee, plus manche et soie.
 */
export function makeTrowelGeometry() {
  const shape = new THREE.Shape();
  const L = 0.18, W = 0.075;
  shape.moveTo(0, L * 0.55);
  shape.quadraticCurveTo(W * 0.52, L * 0.02, W * 0.46, -L * 0.34);
  shape.quadraticCurveTo(W * 0.30, -L * 0.46, 0, -L * 0.45);
  shape.quadraticCurveTo(-W * 0.30, -L * 0.46, -W * 0.46, -L * 0.34);
  shape.quadraticCurveTo(-W * 0.52, L * 0.02, 0, L * 0.55);

  const blade = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0018, bevelEnabled: true,
    bevelSize: 0.0035, bevelThickness: 0.0016, bevelSegments: 1,
    curveSegments: 5,
  });
  blade.rotateX(-Math.PI / 2);

  const green = [blade];
  const tang = new THREE.CylinderGeometry(0.005, 0.005, 0.045, 5, 1, true);
  tang.translate(0, 0.026, -L * 0.30);
  green.push(tang);

  const grip = new THREE.CylinderGeometry(0.014, 0.011, 0.085, 6, 1, true);
  grip.rotateX(0.22);
  grip.translate(0, 0.062, -L * 0.36);

  return { green: mergeGeoms(green), white: mergeGeoms([grip]) };
}

/**
 * Mirette (loop tool, Bible §3.3.2) : manche + soie + boucle metallique.
 * Le seul outil dont l'element actif est un TROU — la boucle doit donc etre un
 * vrai anneau ferme, sinon la lecture s'effondre.
 */
export function makeCarveGeometry() {
  const grip = new THREE.CylinderGeometry(0.009, 0.0075, 0.10, 6, 1, true);
  grip.translate(0, 0.055, 0);

  const metal = [];
  const stem = new THREE.CylinderGeometry(0.0022, 0.0022, 0.055, 4, 1, true);
  stem.rotateX(0.30);
  stem.translate(0, -0.020, 0.008);
  metal.push(stem);

  const loop = makeArc(0.022, 0.0016, 0, Math.PI * 2, 12);
  loop.rotateX(Math.PI * 0.5 + 0.30);
  loop.translate(0, -0.058, 0.024);
  metal.push(loop);

  return { red: mergeGeoms([grip]), metal: mergeGeoms(metal) };
}

/**
 * Rateau : manche, traverse, dents. Le nombre de dents suit `tool.spacing`,
 * donc la geometrie est REGENEREE quand l'ecartement change — evenement rare
 * (Ctrl+Maj+molette) et geometrie minuscule. C'est une jauge diegetique
 * gratuite : le rateau qu'on voit a le peigne qu'on va graver.
 */
export function makeRakeGeometry(spacing = 0.05, width = 0.28) {
  const L = 0.40;
  const shaft = new THREE.CylinderGeometry(0.010, 0.012, L, 6, 1, true);
  shaft.rotateX(0.30);
  shaft.translate(0, L * 0.48, -0.05);

  const red = [];
  const bar = new THREE.BoxGeometry(width, 0.014, 0.016);
  red.push(bar);

  const n = Math.max(3, Math.min(9, Math.round(width / Math.max(0.02, spacing)) + 1));
  for (let i = 0; i < n; i++) {
    const x = -width * 0.5 + (width * i) / (n - 1);
    const tooth = new THREE.CylinderGeometry(0.0022, 0.0042, 0.052, 4, 1, true);
    tooth.translate(x, -0.030, 0);
    red.push(tooth);
  }
  return { red: mergeGeoms(red), white: mergeGeoms([shaft]) };
}

/**
 * Dame / tamper (Bible §3.1) : plaque + manche court. Elle REMPLACE la main.
 *
 * On ne modelise pas de main : a la distance de travail, une main ferait 22 px
 * de haut, soit trois pixels par doigt — une patate rose. Or le geste de
 * tassement se fait, dans la vraie vie, a la dame. C'est donc plus fidele a la
 * pratique, ca se lit a 18 px, et l'icone « main » reste dans le HUD parce que
 * le joueur, lui, pense « main ».
 */
export function makeTamperGeometry() {
  const white = [];
  const red = [];

  const plate = makeScoop(0.060, 0.100, 0.004, 3);
  plate.rotateX(Math.PI);
  white.push(plate);

  const rim = new THREE.BoxGeometry(0.120, 0.010, 0.100);
  rim.translate(0, 0.006, 0);
  white.push(rim);

  const shaft = new THREE.CylinderGeometry(0.010, 0.010, 0.10, 6, 1, true);
  shaft.translate(0, 0.062, 0);
  white.push(shaft);

  const knob = new THREE.SphereGeometry(0.017, 7, 4);
  knob.scale(1, 0.75, 1);
  knob.translate(0, 0.118, 0);
  red.push(knob);

  return { white: mergeGeoms(white), red: mergeGeoms(red) };
}

// ---------------------------------------------------------------------------
// L'ATELIER DU SCULPTEUR
// ---------------------------------------------------------------------------

/** Couteau de sculpteur : lame fine et manche de bois, pour percer les ouvertures. */
export function makeKnifeGeometry() {
  const blade = new THREE.BoxGeometry(0.022, 0.0025, 0.12);
  blade.translate(0, 0, 0.06);
  const handle = new THREE.CylinderGeometry(0.009, 0.011, 0.085, 8);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, 0, -0.045);
  return { metal: mergeGeoms([blade]), handle: mergeGeoms([handle]) };
}

/** Gabarit d'escalier : trois marches empilees, la jauge qu'on pose sur la pente. */
export function makeStairsGaugeGeometry() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const len = 0.03 * (3 - i);
    const b = new THREE.BoxGeometry(0.06, 0.02, len);
    b.translate(0, 0.01 + i * 0.02, len * 0.5);
    parts.push(b);
  }
  const grip = new THREE.CylinderGeometry(0.006, 0.006, 0.07, 6);
  grip.translate(0, 0.095, 0.02);
  return { yellow: mergeGeoms(parts), handle: mergeGeoms([grip]) };
}

/** La paille : un tube fin, tenu incline, avec sa rayure rouge. */
export function makeStrawGeometry() {
  const tube = new THREE.CylinderGeometry(0.0035, 0.0035, 0.20, 8, 1, true);
  tube.rotateX(Math.PI / 2);
  const stripe = new THREE.CylinderGeometry(0.0038, 0.0038, 0.05, 8, 1, true);
  stripe.rotateX(Math.PI / 2);
  stripe.translate(0, 0, -0.06);
  return { white: mergeGeoms([tube]), red: mergeGeoms([stripe]) };
}

/** Le reglet : une regle plate de 20 cm, graduee tous les 2 cm. */
export function makeRuleGeometry() {
  const bar = new THREE.BoxGeometry(0.03, 0.005, 0.20);
  const ticks = [];
  for (let k = 0; k <= 10; k++) {
    const major = k % 5 === 0;
    const t = new THREE.BoxGeometry(major ? 0.016 : 0.008, 0.0012, 0.0015);
    t.translate(major ? -0.006 : -0.010, 0.0031, -0.1 + k * 0.02);
    ticks.push(t);
  }
  return { yellow: mergeGeoms([bar]), metal: mergeGeoms(ticks) };
}
