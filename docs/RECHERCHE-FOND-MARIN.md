# Recherche — Fond marin et végétation

> Diorama de plage tropicale, 10,24 m × 10,24 m, voxels de 4 cm.
> Tout est généré en code : **aucun asset externe, aucune texture chargée**.
> Cible : three.js r185, `InstancedMesh` / `BatchedMesh`.

---

## 0. Le problème, et pourquoi il est le plus important

Notre fond marin est du sable nu. Vu de dessus à travers une eau turquoise
transparente, c'est un aplat beige. Résultat : l'eau n'a **pas de profondeur
lisible**. On voit bien qu'elle est bleue, mais on ne voit rien *dedans*, donc
l'œil la lit comme une surface peinte posée sur le sable, pas comme un volume.

La force visuelle de la référence (Sandcastle, Bubblebird Studio) tient
exactement à ça : l'eau est claire, et **elle laisse voir un fond riche**.
Massifs de corail rose et orange, touffes d'algues, herbiers verts, rochers,
taches de sable clair. Chaque objet immergé est un repère de profondeur : plus
il est loin sous la surface, plus il est désaturé et bleuté. C'est la richesse
du fond qui *crée* la transparence perçue de l'eau, pas l'inverse.

Trois conséquences pour la conception :

1. **La densité prime sur la qualité unitaire.** Mille touffes d'algues à 80
   triangles battent cinquante coraux à 3 000. On instancie par milliers.
2. **La couleur source doit être poussée.** L'eau mange le rouge en quelques
   dizaines de centimètres. Un corail « rose correct » à sec devient gris-bleu
   sous 60 cm d'eau. Il faut peindre les coraux plus saturés et plus chauds
   qu'ils ne devraient l'être, pour qu'ils *arrivent* justes après absorption.
3. **Le mouvement fait la vie.** Un fond figé est un décor ; un fond qui ondule
   lentement est un milieu. L'ondulation sous-marine coûte quelques lignes de
   vertex shader et change tout.

Ce document décrit la zonation, la géométrie procédurale de chaque espèce,
l'animation, les couleurs, la distribution, le budget, et le plan d'intégration
dans `src/render/Props.js`.

---

## 1. Zonation

### 1.1 Les grandeurs dont on dispose déjà

`BeachGenerator.js` expose `shoreDistance(wx, wz)` : la distance signée au
rivage moyen, **positive côté terre**. Tout le reste s'en déduit :

```js
import { shoreDistance, beachProfile, shorelineFor } from '../world/BeachGenerator.js';
import { SEA_LEVEL, TIDE_AMPLITUDE } from '../core/Config.js';

// Altitude du terrain « nominal » à une distance de rivage donnée
const bed = beachProfile(d);
// Profondeur d'eau à marée moyenne
const depthMean = SEA_LEVEL - bed;
// Profondeur à basse mer / haute mer
const depthLow  = (SEA_LEVEL - TIDE_AMPLITUDE) - bed;
const depthHigh = (SEA_LEVEL + TIDE_AMPLITUDE) - bed;
```

Avec nos constantes (`SEA_LEVEL = 1.05`, `TIDE_AMPLITUDE = 0.46`,
`BEACH_HEIGHT = 1.60`), les deux repères qui structurent toute la zonation
sont :

| Repère | Niveau de la mer | Position du rivage |
|---|---|---|
| Basse mer | 0,59 m | `d = −1,75 m` |
| Mer moyenne | 1,05 m | `d = 0,00 m` |
| Haute mer | 1,51 m | `d = +2,47 m` |

Autrement dit : **l'estran fait 4,2 m de large**, soit un tiers du domaine.
La zone en permanence immergée (`d < −1,75`) ne fait que ~11 m² — c'est là que
va tout le récif, et c'est pour ça qu'il doit être dense.

### 1.2 Table de zonation

Surfaces calculées pour notre rivage en diagonale (normale `(0.447, 0.894)`,
offset `1.95`) sur un carré de 10,24 m.

| # | Zone | `d` (m) | Prof. moy. (m) | Prof. basse mer | Surface | Densité totale | Espèces dominantes | Couleurs dominantes |
|---|---|---|---|---|---|---|---|---|
| 0 | **Herbier profond** | `d < −3,2` | 0,90 | 0,44 | 3,7 m² | ~310 / m² | herbier dense (tapis), algues brunes, gorgones hautes, gros rochers | verts sourds `#3E7D4F`, bruns `#7A6A2E` |
| 1 | **Récif** | `−3,2 … −2,4` | 0,90 → 0,71 | 0,44 → 0,25 | 4,2 m² | ~190 / m² | **acropora branchu**, cerveau, tabulaire, gorgone, oursins, herbier | roses `#E8709A`, orangés `#F2833C`, violets `#A470C8` |
| 2 | **Platier** | `−2,4 … −1,9` | 0,71 → 0,52 | 0,25 → 0,06 | 3,5 m² | ~210 / m² | coraux massifs bas, encroûtants, algues vertes, herbier ras, oursins | ocres `#C98A4B`, verts `#4E8F42` |
| 3 | **Sable sous-marin** | `−1,9 … −1,2` | 0,52 → 0,25 | 0,06 → découvert | 5,9 m² | ~70 / m² | herbier clairsemé, touffes d'algues isolées, coquillages, étoiles, galets | sable clair, ponctuations vertes |
| 4 | **Estran** | `−1,2 … +2,2` | 0,25 → 0 | découvert | 38,0 m² | ~9 / m² | coquillages, galets, bernard-l'ermite, algues échouées | bruns humides, gris |
| 5 | **Laisse de mer** | `+2,2 … +3,2` | — | — | 11,5 m² | ~29 / m² | coquillages en cordon, paquets d'algues séchées, bois flotté, galets | ocres `#C9A882`, gris-vert `#8A8A6E` |
| 6 | **Haut de plage sec** | `+3,2 … +5,2` | — | — | 22,9 m² | ~5 / m² | galets, coquillages blanchis, rares touffes pionnières | sable clair, blancs |
| 7 | **Arrière-dune** | `d > +5,2` | — | — | 15,2 m² | ~46 / m² | **oyats**, buissons ronds, plantes grasses, galets | dorés `#B9A45C`, verts `#5C7A46` |

### 1.3 Règles de bord

Trois règles évitent l'effet « bandes de peinture » :

- **Chevauchement.** Chaque espèce a une plage `[dMin, dMax]` et deux marges de
  fondu `fade`. La probabilité de dépôt suit un trapèze, pas un créneau.
- **Bruit de frontière.** On perturbe `d` avec le même `fbm2` que
  `shoreDistance`, ce qui fait onduler les limites de zone de ±0,5 m.
- **Contrainte de pente.** Un corail ne pousse pas sur du sable en pente à
  30 %. On rejette les points où `|∇h| > tan(20°)` pour les coraux et rochers,
  alors que l'herbier accepte jusqu'à 35°.

```js
// src/world/BiomeScatter.js
/** Poids d'appartenance d'un point à une zone, avec fondus aux bords. */
export function zoneWeight(d, dMin, dMax, fade = 0.35) {
  if (d <= dMin - fade || d >= dMax + fade) return 0;
  const inLow  = smoothstep(dMin - fade, dMin + fade * 0.5, d);
  const inHigh = 1 - smoothstep(dMax - fade * 0.5, dMax + fade, d);
  return Math.min(inLow, inHigh);
}
```

---

## 2. Génération procédurale

### 2.1 Socle commun

Toutes les géométries partagent trois besoins : un aléatoire **déterministe**
(la même graine donne le même récif, indispensable pour la sauvegarde), un
accumulateur de triangles, et un attribut de souplesse `aFlex` (0 à la base,
1 à la pointe) que le vertex shader d'animation lira.

```js
// src/world/Biota.js
import * as THREE from 'three';

/** PRNG déterministe (mulberry32). Déjà présent dans Props.js — on l'exporte. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);

/** Repère orthonormé perpendiculaire à `dir`. */
function orthoBasis(dir, outU, outV) {
  const ref = Math.abs(dir.y) > 0.9 ? AX : AY;
  outU.crossVectors(dir, ref).normalize();
  outV.crossVectors(dir, outU).normalize();
}

/**
 * Accumulateur de géométrie non indexée, à faces planes.
 *
 * Non indexée et plate : c'est le bon choix ici. Nos objets font 20 à 300
 * triangles ; l'index coûterait plus en complexité qu'il ne fait gagner en
 * sommets, et le rendu à facettes donne aux coraux et aux rochers ce côté
 * « taillé » qui lit très bien à petite échelle.
 */
export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.flex = [];
    this.tris = 0;
  }

  /** Triangle plat. fa/fb/fc = valeurs de souplesse aux trois sommets. */
  tri(a, b, c, fa = 0, fb = 0, fc = 0) {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    const len = _n.length();
    if (len < 1e-9) return this;          // triangle dégénéré : on jette
    _n.multiplyScalar(1 / len);
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.nrm.push(_n.x, _n.y, _n.z);
    this.flex.push(fa, fb, fc);
    this.tris++;
    return this;
  }

  quad(a, b, c, d, f0 = 0, f1 = 0) {
    this.tri(a, b, c, f0, f0, f1);
    this.tri(a, c, d, f0, f1, f1);
    return this;
  }

  /**
   * Tronc de prisme entre deux disques : la brique de base de tout ce qui est
   * branchu. `sides` = 3 pour les brindilles, 5 ou 6 pour un tronc.
   */
  segment(p0, r0, f0, p1, r1, f1, sides = 4, twist = 0) {
    _u.subVectors(p1, p0);
    if (_u.lengthSq() < 1e-10) return this;
    _u.normalize();
    orthoBasis(_u, _e1, _e2);
    const A = [], B = [];
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2 + twist;
      const cx = Math.cos(t), cz = Math.sin(t);
      A.push(new THREE.Vector3(
        p0.x + (_e1.x * cx + _e2.x * cz) * r0,
        p0.y + (_e1.y * cx + _e2.y * cz) * r0,
        p0.z + (_e1.z * cx + _e2.z * cz) * r0));
      B.push(new THREE.Vector3(
        p1.x + (_e1.x * cx + _e2.x * cz) * r1,
        p1.y + (_e1.y * cx + _e2.y * cz) * r1,
        p1.z + (_e1.z * cx + _e2.z * cz) * r1));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.quad(A[i], B[i], B[j], A[j], f0, f1);
    }
    return this;
  }

  /** Bouchon conique au bout d'une branche : `sides` triangles. */
  cap(p, r, dir, len, f, sides = 4) {
    _u.copy(dir).normalize();
    orthoBasis(_u, _e1, _e2);
    const tip = new THREE.Vector3().copy(p).addScaledVector(_u, len);
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2;
      const cx = Math.cos(t), cz = Math.sin(t);
      ring.push(new THREE.Vector3(
        p.x + (_e1.x * cx + _e2.x * cz) * r,
        p.y + (_e1.y * cx + _e2.y * cz) * r,
        p.z + (_e1.z * cx + _e2.z * cz) * r));
    }
    for (let i = 0; i < sides; i++) {
      this.tri(ring[i], tip, ring[(i + 1) % sides], f, 1, f);
    }
    return this;
  }

  /** Ruban plat (lame d'algue, brin d'herbe, branche de gorgone). */
  ribbon(p0, p1, side, w0, w1, f0, f1) {
    const a = new THREE.Vector3().copy(p0).addScaledVector(side, -w0);
    const b = new THREE.Vector3().copy(p0).addScaledVector(side, +w0);
    const c = new THREE.Vector3().copy(p1).addScaledVector(side, +w1);
    const d = new THREE.Vector3().copy(p1).addScaledVector(side, -w1);
    return this.quad(a, b, c, d, f0, f1);
  }

  /** Absorbe une BufferGeometry three.js existante (sphère, icosaèdre…). */
  absorb(g, flexFn = () => 0) {
    const p = g.attributes.position;
    if (!g.attributes.normal) g.computeVertexNormals();
    const nn = g.attributes.normal;
    const idx = g.index;
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i++) {
      const j = idx ? idx.getX(i) : i;
      const x = p.getX(j), y = p.getY(j), z = p.getZ(j);
      this.pos.push(x, y, z);
      this.nrm.push(nn.getX(j), nn.getY(j), nn.getZ(j));
      this.flex.push(flexFn(x, y, z));
    }
    this.tris += count / 3;
    g.dispose();
    return this;
  }

  build(name = '') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.flex, 1));
    g.computeBoundingSphere();
    g.userData.tris = this.tris;
    g.name = name;
    return g;
  }
}
```

> **Budget par géométrie : ~300 triangles.** Chaque fonction ci-dessous
> annonce son compte. Le builder expose `this.tris` : on peut arrêter une
> récursion dès que le budget est atteint, ce qui rend le compte *garanti* et
> pas seulement espéré.

### 2.2 Corail branchu (acropora) — ~320 tris

L'acropora est l'objet le plus rentable du récif : c'est la silhouette qui dit
« corail » en une fraction de seconde. Sa loi de croissance est simple et
connue : bifurcation avec **épaississement vers la base** (chaque branche mère
a un rayon égal à la racine cubique de la somme des cubes des filles — la loi
de da Vinci, qui vaut aussi pour les coraux), angle de divergence de 25 à 45°,
et raccourcissement géométrique de 0,72 par niveau.

Deux détails qui font toute la crédibilité :
- **Le phototropisme.** Les branches se redressent vers la lumière. On mélange
  la direction héritée avec `+Y` d'un facteur qui croît avec le niveau.
- **Les pointes claires.** Le bout des acropora est plus pâle (tissu en
  croissance, moins de zooxanthelles). C'est `aFlex` qui portera ce dégradé
  dans le fragment shader — gratuit.

```js
/**
 * Corail branchu type Acropora.
 * Système récursif à 4 niveaux, sections carrées (4 côtés) sauf le tronc.
 * ~320 triangles pour `budget = 320`.
 */
export function makeBranchingCoral(seed = 1, opts = {}) {
  const {
    height = 0.20,          // hauteur hors tout (m)
    baseRadius = 0.018,
    levels = 4,
    spread = 0.55,          // ouverture de la colonie
    upBias = 0.45,          // phototropisme
    budget = 320,
  } = opts;

  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  /**
   * @param {THREE.Vector3} p  base de la branche
   * @param {THREE.Vector3} dir direction unitaire
   * @param {number} len longueur
   * @param {number} r rayon à la base
   * @param {number} level niveau restant
   * @param {number} f0 souplesse à la base (0..1)
   */
  function branch(p, dir, len, r, level, f0) {
    if (level <= 0 || B.tris > budget - 12 || r < 0.0016) {
      // Pointe : petit cône, ~4 triangles.
      B.cap(p, r, dir, len * 0.55, f0, 4);
      return;
    }
    const sides = level >= levels - 1 ? 6 : 4;
    // 2 segments par branche : assez pour montrer la courbure du phototropisme
    const SEG = level >= levels - 1 ? 3 : 2;
    const cur = p.clone();
    const d = dir.clone();
    let rr = r;
    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      // La branche se redresse progressivement
      d.lerp(AY, upBias * 0.22).normalize();
      const nxt = cur.clone().addScaledVector(d, len / SEG);
      const r1 = r * (1 - 0.42 * t1);
      B.segment(cur, rr, f0 + (1 - f0) * t0 * 0.4,
                nxt, r1, f0 + (1 - f0) * t1 * 0.4, sides,
                rnd() * 0.9);
      cur.copy(nxt);
      rr = r1;
    }

    // Bifurcation : 2 ou 3 filles.
    const n = rnd() < 0.35 ? 3 : 2;
    // Loi de da Vinci : r_mere^3 = somme(r_fille^3)
    const rc = rr * Math.pow(1 / n, 1 / 3) * 0.96;
    const phi0 = rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const phi = phi0 + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
      const theta = spread * (0.55 + rnd() * 0.7);   // écart à l'axe
      orthoBasis(d, _e1, _e2);
      const nd = d.clone()
        .multiplyScalar(Math.cos(theta))
        .addScaledVector(_e1, Math.sin(theta) * Math.cos(phi))
        .addScaledVector(_e2, Math.sin(theta) * Math.sin(phi))
        .normalize();
      branch(cur.clone(), nd, len * (0.68 + rnd() * 0.10), rc, level - 1,
             Math.min(1, f0 + 0.24));
    }
  }

  const trunkLen = height * 0.34;
  branch(new THREE.Vector3(0, 0, 0), AY.clone(), trunkLen, baseRadius, levels, 0);

  // Petit bourrelet d'encroûtement à la base : sans lui la colonie a l'air
  // plantée dans le sable comme un piquet.
  const foot = new THREE.IcosahedronGeometry(baseRadius * 2.3, 0);
  const fp = foot.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    fp.setY(i, Math.max(-baseRadius * 0.2, fp.getY(i) * 0.32));
  }
  foot.computeVertexNormals();
  B.absorb(foot, () => 0);

  return B.build('coral_branch');
}
```

**Variantes.** Trois jeux de paramètres suffisent à peupler un récif :

```js
export const ACROPORA_VARIANTS = [
  // corne de cerf : élancé, peu ramifié
  { seed: 11, height: 0.26, baseRadius: 0.016, levels: 4, spread: 0.38, upBias: 0.70 },
  // table basse / corymbose : trapu, très ramifié
  { seed: 23, height: 0.14, baseRadius: 0.022, levels: 4, spread: 0.85, upBias: 0.25 },
  // digité : gros doigts courts
  { seed: 37, height: 0.17, baseRadius: 0.026, levels: 3, spread: 0.50, upBias: 0.55 },
];
```

### 2.3 Corail massif / cerveau — ~80 tris

Un icosaèdre de subdivision 1 (80 triangles), aplati, bosselé par du bruit
basse fréquence, et **creusé de sillons** par une fonction sinusoïdale de la
latitude sphérique. Le truc pour que les sillons se lisent : les creuser sur la
*position*, pas seulement sur la normale — le silhouettage doit les montrer.

```js
/** Corail massif (Diploria / Platygyra). 80 triangles. */
export function makeBrainCoral(seed = 2, opts = {}) {
  const { radius = 0.10, squash = 0.62, grooves = 7, depth = 0.10 } = opts;
  const rnd = mulberry32(seed);
  const ax = rnd() * 6.28, az = rnd() * 6.28;

  const g = new THREE.IcosahedronGeometry(radius, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();

    // Bosselage général : la colonie n'est jamais une sphère parfaite
    const lump = 1
      + 0.13 * Math.sin(n.x * 5.3 + ax) * Math.cos(n.z * 4.1 + az)
      + 0.07 * Math.sin(n.y * 8.7 + ax * 2.0);

    // Sillons méandriformes : une sinusoïde de la latitude, modulée par la
    // longitude pour qu'ils serpentent au lieu d'être des cercles concentriques.
    const lat = Math.asin(Math.max(-1, Math.min(1, n.y)));
    const lon = Math.atan2(n.z, n.x);
    const wander = 0.55 * Math.sin(lon * 3.0 + ax);
    const s = Math.sin((lat + wander) * grooves * 2.0);
    const groove = 1 - depth * (0.5 + 0.5 * Math.cos(s * Math.PI)) * 0.5;

    const k = lump * groove;
    // Aplatissement : un cerveau est un dôme, pas une boule.
    v.set(v.x * k, Math.max(0, v.y) * k * squash, v.z * k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();

  const B = new GeoBuilder();
  // aFlex = 0 partout : un corail massif ne bouge pas. Mais on garde un léger
  // gradient vertical pour le dégradé de couleur (sommet plus clair, éclairé).
  B.absorb(g, (x, y) => Math.min(1, Math.max(0, y / (radius * squash))));
  return B.build('coral_brain');
}
```

### 2.4 Corail tabulaire / en plateau — ~110 tris

Un pied court, un plateau circulaire légèrement conique, un bord ourlé plus
clair (marge de croissance) et une face inférieure. C'est l'espèce qui donne
l'**ombre portée** sur le sable — et donc la profondeur.

```js
/** Corail tabulaire (Acropora hyacinthus). ~110 triangles. */
export function makeTableCoral(seed = 3, opts = {}) {
  const { radius = 0.13, thickness = 0.010, stem = 0.045, sides = 14 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  // Pied
  B.segment(new THREE.Vector3(0, 0, 0), 0.022, 0,
            new THREE.Vector3(0, stem, 0), 0.014, 0.25, 6);

  // Plateau : deux couronnes, top et bottom, plus une tranche.
  const top = [], bot = [];
  const rr = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    // Contour irrégulier : un vrai plateau n'est jamais un disque
    const r = radius * (0.82 + 0.18 * Math.sin(a * 3 + rnd() * 0.4) + rnd() * 0.06);
    rr.push(r);
    // Légère remontée du bord : le plateau est un chapeau, pas une assiette
    const lift = stem + 0.012 * Math.pow(r / radius, 2.2);
    top.push(new THREE.Vector3(Math.cos(a) * r, lift, Math.sin(a) * r));
    bot.push(new THREE.Vector3(Math.cos(a) * r, lift - thickness, Math.sin(a) * r));
  }
  const cTop = new THREE.Vector3(0, stem, 0);
  const cBot = new THREE.Vector3(0, stem - thickness, 0);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    B.tri(cTop, top[i], top[j], 0.15, 1.0, 1.0);      // dessus
    B.tri(cBot, bot[j], bot[i], 0.15, 1.0, 1.0);      // dessous
    B.quad(top[i], bot[i], bot[j], top[j], 1.0, 1.0); // tranche = la marge claire
  }
  return B.build('coral_table');
}
```

### 2.5 Gorgone / éventail de mer — ~130 tris

Une gorgone est un **treillis plan** : quelques branches maîtresses, des
branches secondaires, et des anastomoses qui les relient. On la construit comme
un graphe 2D dans le plan XY, puis on émet chaque arête en ruban plat. Le
matériau est `DoubleSide` et l'objet ondule de tout son corps dans le courant —
c'est le seul élément du récif qui bouge en bloc.

```js
/** Gorgone / éventail de mer. Treillis plan, ~130 triangles. */
export function makeSeaFan(seed = 4, opts = {}) {
  const { height = 0.24, width = 0.20, levels = 4, thick = 0.0022 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();
  const SIDE = new THREE.Vector3(0, 0, 1);   // épaisseur hors du plan
  const nodes = [];   // pour les anastomoses

  function grow(p, ang, len, w, level) {
    if (level <= 0 || B.tris > 118) return;
    const dir = new THREE.Vector2(Math.sin(ang), Math.cos(ang));
    const q = new THREE.Vector3(p.x + dir.x * len, p.y + dir.y * len, 0);
    const f0 = p.y / height, f1 = q.y / height;
    B.ribbon(p, q, SIDE, w, w * 0.72, f0, f1);
    // épaisseur : un second ruban perpendiculaire, croix -> se lit de profil
    B.ribbon(p, q, new THREE.Vector3(dir.y, -dir.x, 0).multiplyScalar(0.6),
             w * 0.6, w * 0.45, f0, f1);
    nodes.push({ p: q, ang, level });

    const n = level > 2 ? 2 : (rnd() < 0.65 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const spread = 0.44 * (n === 1 ? 0 : (i === 0 ? -1 : 1));
      grow(q, ang + spread + (rnd() - 0.5) * 0.22,
           len * (0.70 + rnd() * 0.10), w * 0.74, level - 1);
    }
  }

  grow(new THREE.Vector3(0, 0, 0), 0, height * 0.30, thick * 2.6, levels);

  // Anastomoses : on relie les nœuds voisins de même niveau. C'est ce qui
  // transforme un arbuste plat en éventail — sans elles, ça reste un buisson.
  for (let i = 0; i < nodes.length && B.tris < 128; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].level !== nodes[j].level) continue;
      const d = nodes[i].p.distanceTo(nodes[j].p);
      if (d > 0.012 && d < 0.05) {
        B.ribbon(nodes[i].p, nodes[j].p, SIDE, thick * 0.8, thick * 0.8,
                 nodes[i].p.y / height, nodes[j].p.y / height);
        break;
      }
    }
  }
  // Léger gauchissement : un éventail parfaitement plan a l'air d'un découpage
  const p = B.pos;
  for (let i = 0; i < p.length; i += 3) {
    p[i + 2] += 0.035 * Math.sin(p[i] * 9.0) * (p[i + 1] / height);
  }
  return B.build('sea_fan');
}
```

### 2.6 Touffe d'algues — ~84 tris

Sept lames souples, larges, orientées en gerbe et **retombantes** : sous l'eau,
une algue n'est pas dressée comme de l'herbe, elle flotte. La courbure initiale
au repos est très importante — c'est elle qui différencie une algue d'un oyat.

```js
/** Touffe d'algues (Sargassum / Ulva). 7 lames × 6 segments = 84 triangles. */
export function makeSeaweedTuft(seed = 5, opts = {}) {
  const { blades = 7, height = 0.16, width = 0.020, droop = 0.55 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();
  const SEG = 6;

  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rnd() * 0.9;
    const h = height * (0.55 + rnd() * 0.75);
    const w = width * (0.7 + rnd() * 0.6);
    const lean = droop * (0.6 + rnd() * 0.8);
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const side = new THREE.Vector3(-dirz, 0, dirx);
    // Chaque lame vrille : la lumière l'attrape différemment sur sa longueur
    const twist = (rnd() - 0.5) * 1.6;

    const pt = (t) => new THREE.Vector3(
      dirx * lean * t * t * h,
      h * t * (1 - 0.28 * t * t),      // retombe en bout
      dirz * lean * t * t * h);

    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      // Largeur : maxi au tiers, effilée aux deux bouts (feuille, pas ruban)
      const wid = (t) => w * Math.sin(Math.pow(t, 0.55) * Math.PI) * 0.9 + w * 0.15;
      const s0 = side.clone().applyAxisAngle(AY, twist * t0);
      B.ribbon(pt(t0), pt(t1), s0, wid(t0), wid(t1), t0, t1);
    }
  }
  return B.build('seaweed');
}
```

### 2.7 Herbier — ~72 tris, mais en tapis

L'herbier n'est pas un objet, c'est une **texture volumique**. Chaque instance
est une petite touffe de 9 brins couvrant ~7 cm ; on en dépose 2 200. Les brins
sont fins, quasi verticaux, avec une pointe brunie (usure) que `aFlex` fera
apparaître dans le shader.

```js
/** Touffe d'herbier (Thalassia / Zostera). 9 brins × 4 segments = 72 triangles. */
export function makeSeagrassTuft(seed = 6, opts = {}) {
  const { blades = 9, height = 0.115, width = 0.0055, patch = 0.030 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();
  const SEG = 4;

  for (let b = 0; b < blades; b++) {
    // Les brins ne partent PAS tous du même point : un herbier est rhizomateux,
    // les pousses sortent le long d'un rhizome rampant.
    const ox = (rnd() - 0.5) * patch * 2;
    const oz = (rnd() - 0.5) * patch * 2;
    const a = rnd() * Math.PI * 2;
    const h = height * (0.55 + rnd() * 0.8);
    const lean = 0.16 + rnd() * 0.26;
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const side = new THREE.Vector3(-dirz, 0, dirx);
    const w = width * (0.75 + rnd() * 0.5);

    const pt = (t) => new THREE.Vector3(
      ox + dirx * lean * t * t * h,
      h * t,
      oz + dirz * lean * t * t * h);

    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      // Le brin garde sa largeur puis se coupe net : les feuilles de posidonie
      // ont un bout arraché, pas une pointe fine.
      const wid = (t) => w * (1 - 0.25 * t);
      B.ribbon(pt(t0), pt(t1), side, wid(t0), wid(t1), t0, t1);
    }
  }
  return B.build('seagrass');
}
```

### 2.8 Rocher — 20 / 80 tris

Icosaèdre bruité. Trois tailles, deux niveaux de subdivision. Le paramètre
important est **l'anisotropie** : un vrai galet est aplati, un vrai rocher est
allongé selon un axe. Une sphère bruitée isotrope a toujours l'air d'une patate.

```js
/**
 * Rocher / galet. detail=0 -> 20 tris ; detail=1 -> 80 tris.
 * `flat` écrase le rocher (galet), `stretch` l'allonge (bloc).
 */
export function makeRock(seed = 7, opts = {}) {
  const {
    radius = 0.09, detail = 1, amp = 0.30,
    flat = 0.68, stretch = 1.25, sink = 0.25,
  } = opts;
  const rnd = mulberry32(seed);
  const o1 = rnd() * 30, o2 = rnd() * 30, o3 = rnd() * 30;
  const axis = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize();

  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    // Deux octaves : de gros plans de fracture + un grain fin
    const n1 = Math.sin(n.x * 3.1 + o1) * Math.cos(n.z * 2.7 + o2) * Math.sin(n.y * 2.3 + o3);
    const n2 = Math.sin(n.x * 9.7 + o2) * Math.cos(n.y * 8.3 + o3);
    const k = 1 + amp * n1 + amp * 0.3 * n2;
    v.multiplyScalar(k);
    // Anisotropie : allongé selon `axis`, aplati en Y
    const along = v.dot(axis);
    v.addScaledVector(axis, along * (stretch - 1));
    v.y *= flat;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  // On enterre la base : un rocher posé sur le sable est toujours à moitié
  // enfoui, jamais en équilibre sur sa pointe.
  g.translate(0, radius * flat * (1 - sink) - radius * flat * 0.4, 0);

  const B = new GeoBuilder();
  B.absorb(g, (x, y) => Math.min(1, Math.max(0, 0.5 + y / (radius * 2))));
  return B.build('rock');
}
```

### 2.9 Coquillage en spirale logarithmique — ~204 tris

Le nôtre est une demi-sphère striée : ça marche de loin, pas de près. Le modèle
de **Raup** (1962) donne un vrai coquillage avec trois paramètres, et il tient
en vingt lignes.

Hélico-spirale : la courbe génératrice (l'ouverture, un cercle) est translatée
le long d'une spirale logarithmique et mise à l'échelle géométriquement.

```
r(θ) = r0 · W^(θ/2π)        rayon de la spirale
y(θ) = T · r(θ)             élévation le long de l'axe d'enroulement
ρ(θ) = D · r(θ)             rayon de l'ouverture
```

- `W` = taux d'expansion par tour (1,8 → cône élancé ; 3,5 → forme de nautile)
- `D` = distance relative de l'ouverture à l'axe (0,25 → serré, 0,7 → ouvert)
- `T` = translation le long de l'axe (0 → plan, 1,5 → très allongé)

```js
/**
 * Coquillage à spirale logarithmique (modèle de Raup).
 * turns=3, steps=18, sides=6 -> ~204 triangles.
 */
export function makeSpiralShell(seed = 8, opts = {}) {
  const {
    turns = 3.0,     // nombre de tours
    W = 2.6,         // expansion par tour
    D = 0.42,        // ouverture / rayon
    T = 0.85,        // translation axiale
    size = 0.030,    // taille finale (m), hauteur hors tout approx
    steps = 18,      // pas le long de la spirale
    sides = 6,       // sommets de la courbe génératrice
    ribs = 9,        // côtes longitudinales
    ribAmp = 0.12,
  } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  const thetaMax = turns * Math.PI * 2;
  const r0 = 0.006;
  // Normalisation : on veut que la dernière spire fasse `size`
  const rEnd = r0 * Math.pow(W, turns);
  const scale = size / (rEnd * (1 + D) * 2);

  /** Point de la courbe génératrice au pas i, angle de génératrice j. */
  function pt(i, j) {
    const th = (i / steps) * thetaMax;
    const r = r0 * Math.pow(W, th / (Math.PI * 2));
    const cx = Math.cos(th) * r, cz = Math.sin(th) * r;
    const cy = T * r;
    // Repère local : radial + axial
    const a = (j / sides) * Math.PI * 2;
    // Côtes : une modulation du rayon de l'ouverture
    const rib = 1 + ribAmp * Math.cos(a * ribs + th * 1.5);
    const rho = D * r * rib;
    const ur = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
    const p = new THREE.Vector3(cx, cy, cz)
      .addScaledVector(ur, Math.cos(a) * rho);
    p.y += Math.sin(a) * rho;
    return p.multiplyScalar(scale);
  }

  for (let i = 0; i < steps; i++) {
    const f0 = i / steps, f1 = (i + 1) / steps;
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      B.quad(pt(i, j), pt(i, j2), pt(i + 1, j2), pt(i + 1, j), f0, f1);
    }
  }
  // Le coquillage doit reposer couché sur le sable, ouverture visible.
  const g = B.build('shell_spiral');
  g.rotateZ(Math.PI * 0.42 + (rnd() - 0.5) * 0.3);
  g.rotateY(rnd() * Math.PI * 2);
  g.computeBoundingSphere();
  // On recale la base à y=0
  const bb = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
  g.translate(0, -bb.min.y, 0);
  return g;
}
```

**Trois espèces** avec trois jeux de paramètres :

```js
export const SHELL_VARIANTS = [
  { name: 'turritelle', turns: 4.2, W: 1.55, D: 0.26, T: 1.9,  size: 0.038, ribs: 12 },
  { name: 'buccin',     turns: 2.8, W: 2.9,  D: 0.46, T: 0.75, size: 0.032, ribs: 8  },
  { name: 'porcelaine', turns: 2.0, W: 4.2,  D: 0.62, T: 0.15, size: 0.026, ribs: 0, ribAmp: 0 },
];
```

### 2.10 Étoile de mer — ~80 tris

L'`ExtrudeGeometry` biseautée actuelle est chère (bevel = beaucoup de
triangles) pour un résultat plat. On construit à la main un corps bombé à cinq
bras : disque central + bras en trois quads, dessus et dessous.

```js
/** Étoile de mer. 5 bras × 2 faces × 3 segments + centre = ~80 triangles. */
export function makeStarfish(seed = 9, opts = {}) {
  const { arms = 5, R = 0.052, r = 0.020, thick = 0.009, curl = 0.25 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();
  const SEG = 3;
  const centerTop = new THREE.Vector3(0, thick, 0);
  const centerBot = new THREE.Vector3(0, 0, 0);

  for (let a = 0; a < arms; a++) {
    const ang = (a / arms) * Math.PI * 2 + rnd() * 0.12;
    const len = R * (0.88 + rnd() * 0.24);
    const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    // Le bras se relève légèrement en bout : une étoile n'est jamais à plat
    const pt = (t, up) => new THREE.Vector3()
      .addScaledVector(dir, r + (len - r) * t)
      .setY(up ? thick * (1 - t * 0.6) + curl * len * t * t : 0.0 + curl * len * t * t);
    const wid = (t) => r * 0.62 * (1 - t) + 0.004;

    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      B.ribbon(pt(t0, true), pt(t1, true), side, wid(t0), wid(t1), t0, t1);   // dessus
      B.ribbon(pt(t1, false), pt(t0, false), side, wid(t1), wid(t0), t1, t0); // dessous
      // tranche
      B.quad(pt(t0, true).addScaledVector(side, wid(t0)),
             pt(t0, false).addScaledVector(side, wid(t0)),
             pt(t1, false).addScaledVector(side, wid(t1)),
             pt(t1, true).addScaledVector(side, wid(t1)), t0, t1);
    }
    // raccord au disque central
    const nAng = ((a + 1) / arms) * Math.PI * 2;
    const nDir = new THREE.Vector3(Math.cos(nAng), 0, Math.sin(nAng));
    B.tri(centerTop, dir.clone().multiplyScalar(r).setY(thick),
          nDir.clone().multiplyScalar(r).setY(thick), 0, 0.2, 0.2);
    B.tri(centerBot, nDir.clone().multiplyScalar(r), dir.clone().multiplyScalar(r), 0, 0.2, 0.2);
  }
  return B.build('starfish');
}
```

### 2.11 Oursin — ~68 tris

Corps = icosaèdre `detail 0` (20 tris). Piquants = 16 pyramides à 3 faces
(3 tris chacune). Les piquants pointent selon la normale du corps, avec une
dispersion angulaire.

```js
/** Oursin. 20 + 16×3 = 68 triangles. */
export function makeUrchin(seed = 10, opts = {}) {
  const { radius = 0.026, spines = 16, spineLen = 0.032, spineR = 0.0026 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  const body = new THREE.IcosahedronGeometry(radius, 0);
  const bp = body.attributes.position;
  for (let i = 0; i < bp.count; i++) bp.setY(i, bp.getY(i) * 0.72);  // aplati
  body.computeVertexNormals();
  body.translate(0, radius * 0.62, 0);
  B.absorb(body, () => 0);

  // Distribution de Fibonacci sur la sphère : régulière sans être en grille
  const GA = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < spines; i++) {
    const y = 1 - (i / (spines - 1)) * 1.35;     // on saute la calotte inférieure
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GA * i;
    const n = new THREE.Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr).normalize();
    if (n.y < -0.25) continue;
    const base = n.clone().multiplyScalar(radius * 0.92);
    base.y = base.y * 0.72 + radius * 0.62;
    const dir = n.clone().add(new THREE.Vector3(
      (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.25)).normalize();
    B.cap(base, spineR, dir, spineLen * (0.7 + rnd() * 0.6), 0.3, 3);
  }
  return B.build('urchin');
}
```

### 2.12 Bernard-l'ermite — ~120 tris

Coquillage spiralé (variante réduite : `steps: 12, sides: 5` → 120 tris) +
pattes en rubans + deux pinces. Il y en aura vingt : on peut se permettre un
peu plus, mais surtout il doit être **reconnaissable en silhouette** — donc les
pattes doivent dépasser franchement de la coquille.

```js
/** Bernard-l'ermite : coquille + 6 pattes + 2 pinces. ~150 triangles. */
export function makeHermitCrab(seed = 12) {
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  // Coquille portée, penchée vers l'arrière
  const shell = makeSpiralShell(seed ^ 0x55, {
    turns: 2.4, W: 2.8, D: 0.48, T: 0.7, size: 0.026, steps: 12, sides: 5, ribs: 6,
  });
  shell.rotateX(-0.5);
  shell.translate(0, 0.014, -0.006);
  B.absorb(shell, () => 0);

  // Pattes : trois de chaque côté, articulées en deux tronçons
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i++) {
      const a = 0.35 + i * 0.42;
      const p0 = new THREE.Vector3(s * 0.008, 0.012, 0.006 - i * 0.006);
      const knee = new THREE.Vector3(s * (0.016 + i * 0.002), 0.018, 0.016 + i * 0.002);
      const foot = new THREE.Vector3(s * (0.022 + i * 0.003), 0.0, 0.020 + i * 0.005);
      B.segment(p0, 0.0022, 0, knee, 0.0018, 0.4, 3);
      B.segment(knee, 0.0018, 0.4, foot, 0.0011, 1.0, 3);
    }
  }
  // Pinces
  for (let s = -1; s <= 1; s += 2) {
    const p0 = new THREE.Vector3(s * 0.007, 0.014, 0.010);
    const p1 = new THREE.Vector3(s * 0.017, 0.010, 0.026);
    B.segment(p0, 0.0026, 0, p1, 0.0034, 0.6, 4);
    B.cap(p1, 0.0034, new THREE.Vector3(s * 0.4, -0.2, 1).normalize(), 0.010, 1.0, 4);
  }
  return B.build('hermit');
}
```

### 2.13 Buisson rond de haut de plage — ~80 tris

Pas une sphère verte : une **masse de feuillage** obtenue en déformant un
icosaèdre avec un bruit à trois octaves, en aplatissant la base (le buisson est
coupé net par le vent de mer), et en creusant deux ou trois lobes. `aFlex` suit
le rayon horizontal : les bords du buisson frémiront, le cœur restera immobile.

```js
/** Buisson rond côtier (type criste-marine / immortelle). 80 triangles. */
export function makeBush(seed = 13, opts = {}) {
  const { radius = 0.13, squash = 0.72, lobes = 3, rough = 0.26 } = opts;
  const rnd = mulberry32(seed);
  const o = [rnd() * 20, rnd() * 20, rnd() * 20];
  const lobeAng = rnd() * 6.28;

  const g = new THREE.IcosahedronGeometry(radius, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const oct1 = Math.sin(n.x * 3.4 + o[0]) * Math.cos(n.z * 3.0 + o[1]);
    const oct2 = Math.sin(n.x * 7.9 + o[1]) * Math.cos(n.y * 6.6 + o[2]);
    const oct3 = Math.sin(n.z * 15.1 + o[2]);
    // Lobes : le buisson est fait de plusieurs coussins accolés
    const lon = Math.atan2(n.z, n.x);
    const lob = 1 + 0.16 * Math.cos(lon * lobes + lobeAng) * Math.max(0, n.y);
    const k = (1 + rough * oct1 + rough * 0.45 * oct2 + rough * 0.18 * oct3) * lob;
    v.multiplyScalar(k);
    v.y *= squash;
    // Base coupée net : le vent salé rabote le dessous
    v.y = Math.max(v.y, -radius * squash * 0.35);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.translate(0, radius * squash * 0.40, 0);

  const B = new GeoBuilder();
  // aFlex = rayon horizontal normalisé -> les bords bougent, le cœur non
  B.absorb(g, (x, y, z) => Math.min(1, Math.hypot(x, z) / radius));
  return B.build('bush');
}
```

### 2.14 Touffe d'oyat (Ammophila) — ~108 tris

La géométrie actuelle est déjà bonne (lames plates qui s'affinent). Trois
corrections d'après l'apparence réelle de l'oyat : les feuilles sont
**enroulées** (section en gouttière, ce qui limite l'évapotranspiration), la
touffe est **plus dense au centre**, et un ou deux **épis** floraux dépassent
nettement. On ajoute `aFlex` et on passe à 6 segments pour que la courbure du
vent soit lisible.

```js
/** Touffe d'oyat. 11 lames × 6 segments × 2 = 132 tris, épis inclus. */
export function makeMarramTuft(seed = 14, opts = {}) {
  const { blades = 11, height = 0.26, width = 0.0085, spikes = 1 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();
  const SEG = 6;

  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rnd() * 0.8;
    // Densité au centre : le rayon d'émergence suit une loi en puissance
    const rad = Math.pow(rnd(), 1.7) * 0.030;
    const h = height * (0.45 + rnd() * 0.85);
    const lean = 0.22 + rnd() * 0.55;
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const side = new THREE.Vector3(-dirz, 0, dirx);
    const w = width * (0.7 + rnd() * 0.6);
    const ox = dirx * rad, oz = dirz * rad;

    const pt = (t) => new THREE.Vector3(
      ox + dirx * lean * t * t * h * 1.1,
      h * t * (1 - 0.10 * t * t),
      oz + dirz * lean * t * t * h * 1.1);

    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      const wid = (t) => w * Math.pow(1 - t, 0.75);
      // Gouttière : on décale le sommet médian hors du plan de la lame.
      // Deux quads au lieu d'un : la feuille attrape la lumière sur deux
      // facettes et cesse de clignoter quand la caméra tourne.
      const up = new THREE.Vector3(0, 0.35, 0);
      const A0 = pt(t0), A1 = pt(t1);
      const m0 = A0.clone().addScaledVector(up, wid(t0));
      const m1 = A1.clone().addScaledVector(up, wid(t1));
      B.quad(A0.clone().addScaledVector(side, -wid(t0)), m0, m1,
             A1.clone().addScaledVector(side, -wid(t1)), t0, t1);
      B.quad(m0, A0.clone().addScaledVector(side, wid(t0)),
             A1.clone().addScaledVector(side, wid(t1)), m1, t0, t1);
    }
  }

  // Épi : une tige nue + une massette fusiforme
  for (let s = 0; s < spikes; s++) {
    const a = rnd() * 6.28;
    const h = height * 1.35;
    const tip = new THREE.Vector3(Math.cos(a) * 0.05, h, Math.sin(a) * 0.05);
    const mid = new THREE.Vector3(Math.cos(a) * 0.02, h * 0.62, Math.sin(a) * 0.02);
    B.segment(new THREE.Vector3(0, 0, 0), 0.0018, 0, mid, 0.0014, 0.6, 3);
    B.segment(mid, 0.0055, 0.6, tip, 0.0018, 1.0, 4);
  }
  return B.build('marram');
}
```

### 2.15 Plante grasse — ~48 tris

Deux rosettes superposées de feuilles charnues triangulaires, pointes rougies
par le sel et le soleil (`aFlex` porte le dégradé).

```js
/** Plante grasse côtière (type Carpobrotus). 2 rosettes × 8 feuilles × 3 = 48 tris. */
export function makeSucculent(seed = 15, opts = {}) {
  const { rings = 2, leaves = 8, len = 0.055, thick = 0.008 } = opts;
  const rnd = mulberry32(seed);
  const B = new GeoBuilder();

  for (let r = 0; r < rings; r++) {
    const rise = r * 0.016;
    const tilt = 0.95 - r * 0.35;         // la rosette du haut est plus dressée
    const L = len * (1 - r * 0.28);
    const off = (r * 0.5 / leaves) * Math.PI * 2;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2 + off + rnd() * 0.12;
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt),
                                   Math.sin(a) * Math.sin(tilt)).normalize();
      const base = new THREE.Vector3(0, rise + 0.006, 0);
      const tip = base.clone().addScaledVector(dir, L * (0.85 + rnd() * 0.3));
      // Feuille : section triangulaire (3 faces), pointe fine
      B.segment(base, thick * 0.55, 0.0,
                base.clone().addScaledVector(dir, L * 0.45), thick, 0.45, 3);
      B.cap(base.clone().addScaledVector(dir, L * 0.45), thick, dir, L * 0.55, 0.45, 3);
    }
  }
  return B.build('succulent');
}
```

### 2.16 Récapitulatif des budgets géométriques

| Espèce | Fonction | Triangles | Variantes |
|---|---|---|---|
| Corail branchu | `makeBranchingCoral` | 320 | 3 |
| Corail cerveau | `makeBrainCoral` | 80 | 2 |
| Corail tabulaire | `makeTableCoral` | 110 | 1 |
| Gorgone | `makeSeaFan` | 130 | 2 |
| Touffe d'algues | `makeSeaweedTuft` | 84 | 2 |
| Herbier | `makeSeagrassTuft` | 72 | 2 |
| Rocher | `makeRock` | 80 | 3 |
| Galet | `makeRock(detail:0)` | 20 | 3 |
| Coquillage spiralé | `makeSpiralShell` | 204 | 3 |
| Étoile de mer | `makeStarfish` | 80 | 1 |
| Oursin | `makeUrchin` | 68 | 2 |
| Bernard-l'ermite | `makeHermitCrab` | 150 | 1 |
| Buisson | `makeBush` | 80 | 2 |
| Oyat | `makeMarramTuft` | 132 | 2 |
| Plante grasse | `makeSucculent` | 48 | 1 |

---

## 3. Animation

### 3.1 Le principe : tout dans le vertex shader

Aucune animation CPU. Chaque instance porte une **phase** et le vertex shader
applique une déformation qui croît vers la pointe. Le coût est de vingt
instructions par sommet, sur ~1,4 M de sommets : négligeable devant le
fragment shader.

Trois attributs par instance :

| Attribut | Type | Rôle |
|---|---|---|
| `aPhase` | float | déphasage temporel, `rnd() * 2π` |
| `aStiff` | float | raideur individuelle 0,7 … 1,3 (un brin sur trois est plus mou) |
| `instanceColor` | vec3 | variation de teinte (natif three.js, `setColorAt`) |

Et un attribut par **sommet** : `aFlex` ∈ [0,1], 0 à la base, 1 à la pointe.

### 3.2 Où insérer le code : après l'instanciation

Piège classique. Dans three.js, `#include <begin_vertex>` donne `transformed`
en **espace objet**, avant `instanceMatrix`. Si on anime là, la direction du
vent doit être ramenée en espace objet — pénible et faux dès qu'il y a une
rotation Y aléatoire par instance.

On remplace plutôt `#include <project_vertex>`, où l'on peut appliquer
`instanceMatrix` soi-même, animer en espace monde, et récupérer gratuitement
l'origine de l'instance (`instanceMatrix[3].xyz`) — dont on a besoin pour
échantillonner le champ d'eau et pour décorréler les phases.

```glsl
// remplace #include <project_vertex>
vec4 iPos = vec4(transformed, 1.0);
vec3 iOrigin = vec3(0.0);
#ifdef USE_INSTANCING
  iPos = instanceMatrix * iPos;
  iOrigin = instanceMatrix[3].xyz;
#endif
vec3 wPos    = (modelMatrix * iPos).xyz;
vec3 wOrigin = (modelMatrix * vec4(iOrigin, 1.0)).xyz;

// ... animation ici, sur wPos ...

vWorldPos = wPos;
vec4 mvPosition = viewMatrix * vec4(wPos, 1.0);
gl_Position = projectionMatrix * mvPosition;
```

### 3.3 Deux fonctions de mouvement, et pourquoi

| | Sous l'eau | Sur terre |
|---|---|---|
| Fréquence | 0,45 … 0,7 rad/s (période 9 à 14 s) | 2 … 9 rad/s |
| Amplitude | grande (30 à 60 % de la hauteur) | petite (8 à 20 %) |
| Enveloppe | continue, quasi sinusoïdale | **rafales** : longues accalmies, pics brefs |
| Direction | celle du courant local, qui s'inverse avec la houle | direction de vent globale + jitter |
| Retour | mou, la plante suit l'eau | élastique, la plante rebondit |

L'erreur à éviter : appliquer la même sinusoïde plus lentement. Un herbier
animé avec une courbe de vent ressemble à de l'herbe sous l'eau, pas à un
herbier. La différence est dans **l'enveloppe** : l'eau pousse en permanence et
change de sens ; le vent frappe, lâche, refrappe.

```glsl
// ---------------------------------------------------------------------------
// Chunk GLSL partagé : src/render/shaders/sway.glsl.js
// ---------------------------------------------------------------------------

// Bruit de valeur 2D, réutilisé de WaterVolume pour rester cohérent.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * ONDULATION SOUS-MARINE.
 * Deux ondes lentes de fréquences incommensurables (0,53 et 0,19 rad/s) : la
 * somme ne se répète jamais à l'œil. Une onde de propagation spatiale
 * (dot(wOrigin.xz, k)) fait courir la houle à travers l'herbier au lieu de le
 * faire respirer en bloc — c'est ce détail qui fait « milieu vivant ».
 *
 * @param flex   0 à la base, 1 à la pointe
 * @param phase  déphasage par instance
 * @param flow   vitesse du courant local (m/s), lue dans le champ d'eau
 * @param height hauteur de référence de l'espèce (m)
 */
vec3 swayUnderwater(vec3 wOrigin, float flex, float phase, float stiff,
                    vec2 flow, float height, float t) {
  // L'amplitude croît en flex^1.6 : quasi nulle au pied, maximale en pointe.
  float k = pow(flex, 1.6) / max(stiff, 0.3);

  // Propagation : une houle qui traverse le tapis à ~0,9 m/s
  float travel = dot(wOrigin.xz, vec2(0.62, 0.78)) * 3.1;

  float w1 = sin(t * 0.53 - travel + phase);
  float w2 = sin(t * 0.19 + phase * 1.61 + travel * 0.4);
  float wave = w1 * 0.62 + w2 * 0.38;

  // Direction : le courant s'il existe, sinon une direction propre à la touffe
  float sp = length(flow);
  vec2 dir = sp > 0.02 ? flow / sp
                       : vec2(cos(phase * 3.7), sin(phase * 3.7));

  // Amplitude de base (l'eau bouge toujours un peu) + apport du courant.
  // Le sqrt écrase les pointes : un courant deux fois plus fort ne couche pas
  // l'herbier deux fois plus, il sature.
  float amp = height * (0.20 + 0.55 * sqrt(clamp(sp, 0.0, 1.4)));

  vec2 bend = dir * wave * amp * k;

  // Le courant impose aussi une INCLINAISON permanente : sous un courant fort,
  // l'herbier reste couché, il n'oscille pas autour de la verticale.
  bend += dir * (height * 0.42 * smoothstep(0.05, 0.9, sp)) * k;

  // Conservation approximative de la longueur : ce qui part sur le côté
  // descend. Sans ça, une lame couchée à 45° reste aussi haute que debout.
  float drop = 0.5 * dot(bend, bend) / max(height, 0.03);
  return vec3(bend.x, -drop, bend.y);
}

/**
 * VENT TERRESTRE, SACCADÉ.
 * L'enveloppe `gust` est une sinusoïde lente élevée au cube : longues
 * accalmies, pics courts. Superposé, un battement rapide (4,3 et 9,1 rad/s)
 * qui n'existe QUE pendant la rafale. Résultat : la touffe est immobile,
 * frissonne, se couche brutalement, revient.
 */
vec3 swayWind(vec3 wOrigin, float flex, float phase, float stiff,
              vec2 windDir, float windStrength, float height, float t) {
  float k = pow(flex, 2.0) / max(stiff, 0.3);

  // Front de rafale traversant la dune à ~2,5 m/s
  float travel = dot(wOrigin.xz, windDir) * 1.4;
  float slow = sin(t * 0.37 - travel + phase * 0.31) * 0.5 + 0.5;
  float gust = pow(slow, 3.0);                      // <- la saccade

  float flap = sin(t * 4.3 + phase) * 0.34
             + sin(t * 9.1 + phase * 2.3) * 0.14
             + sin(t * 17.0 + phase * 0.7) * 0.05;  // frisson des pointes

  float env = windStrength * (0.10 + gust * (0.90 + flap));
  vec2 bend = windDir * env * height * 0.45 * k;

  // Torsion : la touffe pivote un peu sur elle-même sous la rafale. C'est ce
  // qui distingue une vraie herbe d'un drapeau.
  float twist = gust * 0.22 * flex * sin(phase * 5.1);
  float c = cos(twist), s = sin(twist);
  vec3 rel = vec3(0.0);   // rempli par l'appelant si besoin

  float drop = 0.5 * dot(bend, bend) / max(height, 0.03);
  return vec3(bend.x, -drop, bend.y);
}
```

### 3.4 Brancher l'amplitude sur le courant que la simulation connaît déjà

`Water.js` calcule déjà `vx[c]`, `vz[c]` (vitesse moyenne par cellule) et
`h[c]` (hauteur d'eau). Trois façons de les amener au shader :

| Méthode | Coût | Verdict |
|---|---|---|
| Attribut d'instance mis à jour au CPU | 5 300 écritures + upload par frame | ✗ trop cher, et lissage temporel à écrire |
| Uniforme unique (courant moyen global) | gratuit | ✗ tout l'herbier bouge en bloc |
| **Texture de champ** échantillonnée dans le vertex shader | 1 upload de 256×256 RGBA par frame | ✔ |

La texture de champ est de toute façon nécessaire pour l'absorption et pour
`WaterVolume.js` (qui l'attend déjà sous le nom `uField`). On fixe donc son
contrat une bonne fois :

```js
// src/render/WaterField.js
/**
 * Texture de champ partagée par tout ce qui doit « connaître » l'eau :
 * la surface, la jupe de volume (WaterVolume), et les props immergés.
 *
 *   R = altitude de la surface libre (m)      -> profondeur au-dessus d'un point
 *   G = hauteur d'eau h (m)                   -> masque « immergé »
 *   B = vitesse du courant |v| (m/s) / 2      -> amplitude d'ondulation
 *   A = écume 0..1                            -> voile blanc, agitation
 *
 * Half-float si disponible (précision suffisante à 0,5 mm sur 4 m), sinon
 * float. NX × NZ = 256 × 256 : 512 ko en half-float, ré-uploadés une fois par
 * frame. C'est moins que le buffer d'un seul chunk de terrain.
 */
import * as THREE from 'three';
import { NX, NZ } from '../core/Config.js';

export class WaterField {
  constructor(water) {
    this.water = water;
    this.data = new Float32Array(NX * NZ * 4);
    this.tex = new THREE.DataTexture(this.data, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
  }

  update() {
    const W = this.water;
    const surf = W.field.surfaceH;
    const d = this.data;
    for (let c = 0, o = 0; c < NX * NZ; c++, o += 4) {
      const h = W.h[c];
      d[o]     = surf[c] + h;                                  // niveau libre
      d[o + 1] = h;                                            // profondeur
      d[o + 2] = Math.min(1, Math.hypot(W.vx[c], W.vz[c]) * 0.5);
      d[o + 3] = W.foam[c];
    }
    this.tex.needsUpdate = true;
  }
}
```

Et côté shader :

```glsl
uniform sampler2D uField;
uniform vec4 uDomain;      // (originX, originZ, 1/largeur, 1/profondeur)

vec4 sampleField(vec2 xz) {
  vec2 uv = (xz - uDomain.xy) * uDomain.zw;
  return texture2D(uField, clamp(uv, 0.001, 0.999));
}
```

> **Nota sur la direction.** On ne stocke que `|v|`, pas le vecteur. Une algue
> n'a pas besoin de suivre exactement le courant : l'œil ne le vérifie pas, et
> stocker deux canaux signés supplémentaires coûterait une deuxième texture.
> Ce qui se voit, en revanche, c'est **l'intensité** — l'herbier qui se couche
> quand la vague déferle dessus. Si un jour on veut la direction, elle rentre
> dans les canaux B/A d'une seconde texture, la vitesse allant en `length`.

### 3.5 Le matériau complet

```js
// src/render/BiotaMaterial.js
import * as THREE from 'three';
import { SWAY_GLSL, CAUSTIC_GLSL } from './shaders/sway.glsl.js';
import { ORIGIN_X, ORIGIN_Z, WORLD_W, WORLD_D } from '../core/Config.js';

/**
 * Matériau commun à toute la biote.
 *
 * mode : 'water' (ondulation lente) | 'wind' (rafales) | 'static' (rien)
 * Le mode entre dans customProgramCacheKey pour que three ne recompile pas
 * un programme par matériau.
 */
export function createBiotaMaterial(shared, opts = {}) {
  const {
    mode = 'static',
    baseColor = 0x7d9153,
    tipColor = null,
    height = 0.15,
    roughness = 0.78,
    doubleSide = false,
    submersible = true,
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness,
    metalness: 0,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });

  const uniforms = {
    uTime: shared.uTime,
    uField: shared.uField,
    uDomain: { value: new THREE.Vector4(ORIGIN_X, ORIGIN_Z, 1 / WORLD_W, 1 / WORLD_D) },
    uSunColor: shared.uSunColor,
    uSunDir: shared.uSunDir,
    uWaterDeep: shared.uDeep,
    uWindDir: shared.uWindDir,            // vec2
    uWindStrength: shared.uWindStrength,  // float 0..1
    uLastHigh: shared.uLastHigh,          // altitude de la dernière pleine mer
    uBase: { value: new THREE.Color(baseColor).convertSRGBToLinear() },
    uTip: { value: new THREE.Color(tipColor ?? baseColor).convertSRGBToLinear() },
    uHeight: { value: height },
    uAbsorb: { value: submersible ? 1.0 : 0.0 },
  };
  mat.userData.uniforms = uniforms;

  const MODE = mode === 'water' ? 1 : mode === 'wind' ? 2 : 0;
  mat.customProgramCacheKey = () => `biota_${MODE}_${submersible ? 1 : 0}`;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aFlex;
        attribute float aPhase;
        attribute float aStiff;
        uniform float uTime;
        uniform sampler2D uField;
        uniform vec4  uDomain;
        uniform vec2  uWindDir;
        uniform float uWindStrength;
        uniform float uHeight;
        varying float vFlex;
        varying vec3  vWorldPos;
        varying float vSubmerged;   // épaisseur d'eau AU-DESSUS de ce sommet
        ${SWAY_GLSL}
      `)
      .replace('#include <project_vertex>', /* glsl */`
        vec4 iPos = vec4(transformed, 1.0);
        vec3 iOrigin = vec3(0.0);
        #ifdef USE_INSTANCING
          iPos = instanceMatrix * iPos;
          iOrigin = instanceMatrix[3].xyz;
        #endif
        vec3 wPos    = (modelMatrix * iPos).xyz;
        vec3 wOrigin = (modelMatrix * vec4(iOrigin, 1.0)).xyz;

        vec4 fld = sampleField(wOrigin.xz);
        float level = fld.r;
        float depth = fld.g;
        float flow  = fld.b * 2.0;

        #if BIOTA_MODE == 1
          // Sous l'eau : pas d'ondulation si la touffe est à l'air libre
          // (marée basse). Elle s'affaisse au lieu de se figer debout.
          float wet = smoothstep(0.0, 0.05, depth);
          vec2 flowV = vec2(0.7, 0.3) * flow;   // direction dominante du ressac
          vec3 d = swayUnderwater(wOrigin, aFlex, aPhase, aStiff,
                                  flowV, uHeight, uTime);
          // À sec : la plante retombe (elle n'est plus portée par l'eau)
          vec3 limp = vec3(0.0, -uHeight * 0.30 * pow(aFlex, 1.6), 0.0);
          wPos += mix(limp, d, wet);
        #elif BIOTA_MODE == 2
          wPos += swayWind(wOrigin, aFlex, aPhase, aStiff,
                           uWindDir, uWindStrength, uHeight, uTime);
        #endif

        vFlex = aFlex;
        vWorldPos = wPos;
        vSubmerged = max(0.0, min(level - wPos.y, depth));

        vec4 mvPosition = viewMatrix * vec4(wPos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying float vFlex;
        varying vec3  vWorldPos;
        varying float vSubmerged;
        uniform vec3  uBase;
        uniform vec3  uTip;
        uniform vec3  uWaterDeep;
        uniform vec3  uSunColor;
        uniform vec3  uSunDir;
        uniform float uTime;
        uniform float uAbsorb;
        uniform float uLastHigh;
        ${CAUSTIC_GLSL}
      `)
      // Dégradé base -> pointe, appliqué à l'albédo AVANT l'éclairage
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        diffuseColor.rgb *= mix(uBase, uTip, vFlex);
      `)
      // Absorption + caustiques, APRÈS l'éclairage
      .replace('#include <tonemapping_fragment>', /* glsl */`
        if (uAbsorb > 0.5) {
          float d = vSubmerged;
          if (d > 0.0015) {
            // Caustiques : elles éclairent l'objet, donc elles multiplient
            // la lumière reçue avant que celle-ci ne soit réabsorbée.
            float caus = caustics(vWorldPos.xz, uTime)
                       * smoothstep(0.012, 0.07, d)
                       * (1.0 - smoothstep(0.35, 0.80, d))
                       * max(uSunDir.y, 0.0);
            gl_FragColor.rgb *= 1.0 + caus * 0.75;

            // Beer-Lambert. Trajet optique = descente + remontée vers l'œil,
            // d'où le facteur ~1,8 sur la profondeur géométrique.
            vec3 SIGMA = vec3(2.35, 0.48, 0.32);
            vec3 trans = exp(-SIGMA * d * 1.8);
            gl_FragColor.rgb = gl_FragColor.rgb * trans + uWaterDeep * (1.0 - trans) * 0.55;
          } else {
            // Découvert à marée basse : il reste MOUILLÉ. Un corail sec est
            // gris et mat ; un corail qui vient d'être découvert est sombre,
            // saturé et brillant. C'est ce contraste qui rend la marée lisible.
            float wetness = 1.0 - smoothstep(uLastHigh - 0.02, uLastHigh + 0.10, vWorldPos.y);
            gl_FragColor.rgb *= mix(1.0, 0.78, wetness);
            gl_FragColor.rgb = mix(gl_FragColor.rgb,
                                   gl_FragColor.rgb * gl_FragColor.rgb * 1.6, wetness * 0.5);
          }
        }
        #include <tonemapping_fragment>
      `);

    shader.defines = { ...(shader.defines || {}), BIOTA_MODE: MODE };
    mat.userData.shader = shader;
  };

  mat.defines = { ...(mat.defines || {}), BIOTA_MODE: MODE };
  return mat;
}
```

Et les caustiques, factorisées pour rester **identiques** à celles de l'eau —
si les deux dérivent, on voit une couture au bord de l'eau :

```glsl
// CAUSTIC_GLSL
float caustics(vec2 xz, float t) {
  vec2 cp = xz * 11.0;
  float c1 = vnoise2(cp + vec2(t * 0.35, t * 0.22));
  float c2 = vnoise2(cp * 1.7 - vec2(t * 0.28, t * 0.4));
  return pow(clamp(1.0 - abs(c1 - c2) * 3.4, 0.0, 1.0), 3.0);
}
```

### 3.6 Ce qu'on n'anime pas

Coraux massifs, tabulaires, rochers, coquillages, oursins, étoiles, galets :
`mode: 'static'`. Ils bénéficient quand même de l'absorption et des caustiques
(c'est le shader fragment, pas le vertex). Animer un corail massif est
physiquement faux et coûte du temps de vertex pour rien.

Cas particulier : la **gorgone**. Elle est rigide mais son axe de gorgonine est
flexible ; elle ondule **de tout son corps** dans le plan perpendiculaire à
l'éventail. `mode: 'water'` avec `aFlex` = hauteur normalisée et une raideur
`aStiff` élevée (1,8) : petite amplitude, mouvement de balancier lent, très
lisible.

---

## 4. Couleurs

### 4.1 Le problème de l'absorption inverse

Notre eau applique `exp(-SIGMA * d)` avec `SIGMA = (2.35, 0.48, 0.32)`. Sous
40 cm d'eau, la transmission par canal vaut :

```
R : exp(-2.35 × 0.40 × 1.8) = exp(-1.69) = 0.18
G : exp(-0.48 × 0.40 × 1.8) = exp(-0.35) = 0.71
B : exp(-0.32 × 0.40 × 1.8) = exp(-0.23) = 0.79
```

Le rouge perd 82 % de son énergie. **Un corail peint `#E8709A` arrive à l'œil
en `#3A5075`, c'est-à-dire bleu-gris.** D'où la règle de peinture :

> Peindre les espèces immergées avec la couleur qu'on veut voir, **divisée par
> la transmission à leur profondeur de zone**, puis clampée. En pratique :
> tirer le rouge vers le maximum et pousser la saturation.

Le calcul de compensation, à faire une fois au chargement :

```js
/**
 * Compense l'absorption : renvoie la couleur SOURCE à peindre pour qu'un objet
 * placé sous `depth` mètres d'eau soit perçu comme `target`.
 * On clampe à 1 — au-delà de ~50 cm, on ne peut plus compenser le rouge, et
 * c'est normal : c'est ça, la profondeur.
 */
const SIGMA = [2.35, 0.48, 0.32];
export function preCompensate(hex, depth, path = 1.8) {
  const c = new THREE.Color(hex);
  const t = SIGMA.map((s) => Math.exp(-s * depth * path));
  return new THREE.Color(
    Math.min(1, c.r / t[0]),
    Math.min(1, c.g / t[1]),
    Math.min(1, c.b / t[2])
  );
}
```

En pratique on ne l'applique pas mécaniquement (ça sature tout en rouge pur),
mais **à 60 % de son effet**, ce qui donne les valeurs de la table ci-dessous.

### 4.2 Palette

Toutes les valeurs sont des couleurs **sRGB source** à passer par
`convertSRGBToLinear()`. « Base » = pied de la plante, « Pointe » = valeur en
`aFlex = 1`.

#### Récif — immergé

| Espèce | Base | Pointe | Note |
|---|---|---|---|
| Acropora rose | `#F2648F` | `#FFC9DC` | pointes pâles = tissu en croissance |
| Acropora orange | `#FF7A2E` | `#FFD9A6` | la plus lisible sous 60 cm d'eau |
| Acropora violette | `#B45FD6` | `#EBD2F7` | à réserver aux amas profonds |
| Acropora crème | `#E8C89A` | `#FFF0D8` | variante « blanchie », en petite quantité |
| Cerveau vert-doré | `#C9B24E` | `#E4D77A` | sillons assombris par la normale |
| Cerveau brun-rose | `#D08063` | `#E8AE92` | |
| Cerveau vert | `#7FA050` | `#A8C070` | |
| Tabulaire ocre | `#D6944F` | `#FFE2AC` | la marge claire du bord fait tout |
| Tabulaire vert-bleu | `#5FB4A0` | `#B0E2D6` | |
| Gorgone violette | `#9B5FBC` | `#EBDCF5` | polypes sortis = pointes blanchâtres |
| Gorgone jaune | `#EFBB3C` | `#FFEEB0` | |
| Gorgone rouge | `#D64A55` | `#F6A8A2` | rare, en accent |
| Corail mou rose | `#F09DBE` | `#FFE0EC` | masse molle, très saturée |

#### Végétation immergée

| Espèce | Base | Pointe |
|---|---|---|
| Herbier thalassia | `#2F7A45` | `#7FA84A` |
| Herbier zostère clair | `#4E9C58` | `#9CBF63` |
| Algue verte (ulve) | `#3E8F3C` | `#79C455` |
| Algue brune (sargasse) | `#7A6A2E` | `#B39C48` |
| Algue rouge/pourpre | `#8B3A52` | `#C4707F` |
| Algue échouée (sèche) | `#5B5233` | `#8A7C4E` |

#### Faune et minéral

| Espèce | Base | Pointe |
|---|---|---|
| Rocher immergé | `#7E8B84` | `#9EAAA0` |
| Rocher algué | `#5A6E58` | `#89A06B` |
| Galet clair | `#B8AFA0` | `#D2C9B8` |
| Galet sombre | `#7C766C` | `#98918A` |
| Oursin violet | `#4A3268` | `#241A33` |
| Oursin rouge | `#8E2F2F` | `#4A1818` |
| Étoile orange | `#F0873F` | `#FFC077` |
| Étoile rouge | `#E04A4A` | `#FF9086` |
| Étoile bleue | `#3F8FD4` | `#8FC8EC` |
| Bernard-l'ermite (corps) | `#D0553C` | `#F09070` |

#### Terrestre

| Espèce | Base | Pointe |
|---|---|---|
| Oyat doré | `#9C8F4E` | `#D9C982` |
| Oyat vert | `#6E8A4E` | `#A8BC70` |
| Buisson vert sombre | `#4E6B3E` | `#86A75B` |
| Buisson gris-vert | `#6E7A62` | `#A6AE8E` |
| Plante grasse | `#6E9C72` | `#C4785A` |
| Coquillage crème | `#E8D8C0` | `#FFF6E6` |
| Coquillage rosé | `#EBC3B8` | `#FBE6DE` |
| Coquillage strié | `#C9A882` | `#EFDCC0` |
| Bois flotté | `#9C9184` | `#C4BAAA` |

### 4.3 Variation par instance

Deux mécanismes, complémentaires :

**1. `instanceColor` (natif three).** `InstancedMesh.setColorAt(i, color)`
multiplie la diffuse. On y met une variation TSL calibrée : ±6° de teinte,
±12 % de saturation, ±14 % de luminosité. Au-delà, ça se voit comme du bruit.

```js
const _hsl = { h: 0, s: 0, l: 0 };
const _tmp = new THREE.Color();

/** Variation naturelle d'une couleur d'espèce, déterministe par instance. */
function jitterColor(baseHex, rnd, amount = 1) {
  _tmp.set(baseHex).getHSL(_hsl);
  const h = (_hsl.h + (rnd() - 0.5) * 0.033 * amount + 1) % 1;
  const s = clamp(_hsl.s * (1 + (rnd() - 0.5) * 0.24 * amount), 0, 1);
  const l = clamp(_hsl.l * (1 + (rnd() - 0.5) * 0.28 * amount), 0.05, 0.95);
  return _tmp.setHSL(h, s, l);
}
```

**2. Le dégradé `aFlex`.** Il est vertical et propre à la géométrie, donc il
casse la lecture « aplat de couleur » sans coûter un seul octet d'instance.
C'est lui qui donne aux pointes d'acropora leur blanc caractéristique et aux
herbiers leur bout jauni.

**3. Ce qu'il ne faut PAS faire.** Randomiser la teinte espèce par espèce à
partir d'une seule couleur. Un récif crédible a **peu de teintes très
différentes** (rose vif / orange / violet / crème), pas un continuum. On
implémente donc chaque teinte comme une *espèce* distincte avec sa propre
`InstancedMesh`, et on répartit les proportions : 40 % rose, 30 % orange, 18 %
crème, 12 % violet. Le contraste vient de la répartition, pas du bruit.

### 4.4 Cohérence avec l'eau

Le fond marin et l'eau utilisent les **mêmes** `SIGMA`, la **même** fonction
de caustiques et le **même** `uDeep`. C'est un impératif : la surface de l'eau
et le corail vu au travers doivent tendre vers la même couleur quand la
profondeur augmente, sinon le corail « flotte » visuellement au-dessus de
l'eau. Ces trois constantes vivent dans un seul module.

```js
// src/render/shaders/water-optics.js
export const WATER_SIGMA = new THREE.Vector3(2.35, 0.48, 0.32);
export const WATER_SHALLOW = 0x4fc3c9;
export const WATER_DEEP = 0x11455e;
export const CAUSTIC_GLSL = /* glsl */`...`;
```

---

## 5. Distribution

### 5.1 Le bon outil pour chaque motif

| Motif | Espèces | Algorithme |
|---|---|---|
| Tapis dense et régulier | herbier, oyats | **grille jitterée** + rejet de zone |
| Semis espacé | coquillages, galets, étoiles | **dart throwing** sur hachage spatial (Poisson-disc approché) |
| Amas | coraux, buissons, algues, oursins | **processus de Neyman–Scott** (parents + descendance gaussienne) |
| Cordon | laisse de mer | échantillonnage le long d'une ligne bruitée |

Bridson complet n'est pas nécessaire ici. Sur un domaine de 105 m² avec
5 000 points, le dart throwing sur hachage spatial converge en quelques
millisecondes et donne la même sensation. On le garde comme **filtre commun**
appliqué à toutes les méthodes : c'est lui qui empêche l'interpénétration.

```js
// src/world/PointSet.js
/**
 * Ensemble de points avec distance minimale garantie, via hachage spatial.
 * `tryAdd` est en O(1) : on ne teste que les 9 cases voisines.
 *
 * C'est l'alternative pas chère au disque de Poisson de Bridson : au lieu de
 * garantir un remplissage maximal, on garantit seulement la non-collision.
 * Pour de la végétation, c'est exactement ce qu'on veut — un herbier n'est pas
 * régulier, il a des trous.
 */
export class PointSet {
  /** @param {number} cell taille de la case (= plus grand rayon attendu) */
  constructor(cell) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.map = new Map();
    this.points = [];
  }

  _key(gx, gz) { return gx * 73856093 ^ gz * 19349663; }

  /** @returns {boolean} true si le point a été accepté */
  tryAdd(x, z, r, payload) {
    const gx = Math.floor(x * this.inv), gz = Math.floor(z * this.inv);
    const r2 = r * r;
    const span = Math.ceil(r * this.inv);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const bucket = this.map.get(this._key(gx + dx, gz + dz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          const ddx = p.x - x, ddz = p.z - z;
          // Rayon effectif = le plus grand des deux : un gros corail repousse
          // plus loin qu'un brin d'herbe.
          const rr = Math.max(r, p.r);
          if (ddx * ddx + ddz * ddz < rr * rr) return false;
        }
      }
    }
    const k = this._key(gx, gz);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    const pt = { x, z, r, ...payload };
    b.push(pt);
    this.points.push(pt);
    return true;
  }
}
```

### 5.2 Amas naturels : Neyman–Scott

Les coraux ne poussent pas à intervalles réguliers : une larve se fixe, la
colonie prolifère, et il naît un **massif** entouré de sable nu. Le processus
de Neyman–Scott modélise exactement ça en deux temps : on tire des centres de
massif selon un processus de Poisson, puis pour chaque centre on tire une
descendance dont la position suit une gaussienne bivariée autour du parent.

C'est cinq lignes, et c'est la différence entre « du corail a été semé
uniformément » et « il y a un récif ici ».

```js
// src/world/BiomeScatter.js
/**
 * Amas de Neyman–Scott.
 * @param rng      PRNG
 * @param clusters nombre de massifs
 * @param perCluster descendance moyenne par massif
 * @param sigma    écart-type du nuage (m) — le RAYON du massif
 * @param accept   (x, z) => bool : test de zone (profondeur, pente…)
 * @param emit     (x, z, distToParent01) => void
 */
export function scatterClustered(rng, clusters, perCluster, sigma, bounds, accept, emit) {
  const [x0, z0, x1, z1] = bounds;
  let parents = 0, guard = 0;
  while (parents < clusters && guard++ < clusters * 60) {
    const px = x0 + rng() * (x1 - x0);
    const pz = z0 + rng() * (z1 - z0);
    if (!accept(px, pz)) continue;
    parents++;
    // Nombre d'enfants : Poisson approché (variance = moyenne). Un massif
    // sur trois est nettement plus gros que les autres : c'est ce qui donne
    // la hiérarchie de tailles qu'on lit comme « naturel ».
    const n = Math.max(1, Math.round(perCluster * (0.35 + rng() * 1.6)));
    const s = sigma * (0.6 + rng() * 0.9);
    for (let i = 0; i < n; i++) {
      // Box–Muller
      const u1 = Math.max(1e-6, rng()), u2 = rng();
      const rad = s * Math.sqrt(-2 * Math.log(u1));
      const ang = 2 * Math.PI * u2;
      const cx = px + rad * Math.cos(ang);
      const cz = pz + rad * Math.sin(ang);
      if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
      if (!accept(cx, cz)) continue;
      // Les gros individus sont au cœur du massif, les petits en périphérie :
      // c'est la compétition pour la lumière.
      emit(cx, cz, Math.min(1, rad / (s * 2)));
    }
  }
}
```

### 5.3 Le semeur complet

```js
// src/world/BiomeScatter.js (suite)
import { NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Z, SEA_LEVEL, TIDE_AMPLITUDE,
         clamp, smoothstep } from '../core/Config.js';
import { shoreDistance } from './BeachGenerator.js';
import { PointSet } from './PointSet.js';
import { mulberry32 } from './Biota.js';

/**
 * Description déclarative d'une espèce. Tout le reste en découle.
 *
 * pattern : 'carpet' | 'scatter' | 'cluster' | 'strand'
 * d       : [dMin, dMax] plage de distance au rivage
 * count   : nombre d'instances visé (à qualité 1.0)
 * minDist : distance minimale entre deux individus (m)
 * slope   : pente maximale acceptée (tangente)
 */
export const SPECIES = [
  // --- fond marin -----------------------------------------------------------
  { id: 'seagrass',   pattern: 'carpet',  d: [-9.0, -1.15], count: 2200, minDist: 0.055, slope: 0.70, sizeVar: [0.7, 1.4] },
  { id: 'seaweed',    pattern: 'cluster', d: [-9.0, -1.30], count: 520,  minDist: 0.085, slope: 0.55, clusters: 26, sigma: 0.30 },
  { id: 'coralPink',  pattern: 'cluster', d: [-9.0, -1.95], count: 82,   minDist: 0.150, slope: 0.30, clusters: 7,  sigma: 0.38 },
  { id: 'coralOrange',pattern: 'cluster', d: [-9.0, -1.95], count: 62,   minDist: 0.150, slope: 0.30, clusters: 6,  sigma: 0.34 },
  { id: 'coralCream', pattern: 'cluster', d: [-9.0, -2.10], count: 36,   minDist: 0.150, slope: 0.30, clusters: 4,  sigma: 0.30 },
  { id: 'coralPurple',pattern: 'cluster', d: [-9.0, -2.40], count: 24,   minDist: 0.150, slope: 0.28, clusters: 3,  sigma: 0.26 },
  { id: 'brainCoral', pattern: 'scatter', d: [-9.0, -1.90], count: 70,   minDist: 0.200, slope: 0.22 },
  { id: 'tableCoral', pattern: 'scatter', d: [-9.0, -2.30], count: 20,   minDist: 0.320, slope: 0.18 },
  { id: 'seaFan',     pattern: 'cluster', d: [-9.0, -2.20], count: 70,   minDist: 0.110, slope: 0.35, clusters: 9,  sigma: 0.22 },
  { id: 'reefRock',   pattern: 'scatter', d: [-9.0, -1.60], count: 80,   minDist: 0.230, slope: 0.45 },
  { id: 'urchin',     pattern: 'cluster', d: [-9.0, -1.80], count: 80,   minDist: 0.070, slope: 0.50, clusters: 12, sigma: 0.16 },
  // --- estran et laisse -----------------------------------------------------
  { id: 'starfish',   pattern: 'scatter', d: [-3.0,  1.60], count: 40,   minDist: 0.180, slope: 0.35 },
  { id: 'hermit',     pattern: 'scatter', d: [-1.60, 2.00], count: 24,   minDist: 0.250, slope: 0.30 },
  { id: 'shell',      pattern: 'strand',  d: [-1.60, 3.20], count: 420,  minDist: 0.045, slope: 0.60, peak: 2.55, sharp: 0.9 },
  { id: 'driftSeaweed',pattern:'strand',  d: [ 1.90, 3.30], count: 160,  minDist: 0.070, slope: 0.55, peak: 2.60, sharp: 1.6 },
  { id: 'driftwood',  pattern: 'strand',  d: [ 1.80, 3.40], count: 12,   minDist: 0.400, slope: 0.40, peak: 2.55, sharp: 1.1 },
  { id: 'pebble',     pattern: 'scatter', d: [-2.50, 6.50], count: 500,  minDist: 0.055, slope: 0.75 },
  // --- terre ----------------------------------------------------------------
  { id: 'marram',     pattern: 'carpet',  d: [ 4.60, 99.0], count: 600,  minDist: 0.100, slope: 0.85, sizeVar: [0.65, 1.45] },
  { id: 'bush',       pattern: 'cluster', d: [ 5.00, 99.0], count: 80,   minDist: 0.260, slope: 0.60, clusters: 11, sigma: 0.42 },
  { id: 'succulent',  pattern: 'cluster', d: [ 4.20, 99.0], count: 60,   minDist: 0.120, slope: 0.55, clusters: 9,  sigma: 0.28 },
];

/**
 * Sème toutes les espèces. Retourne { [id]: Array<{x,y,z,rot,scale,tint}> }.
 *
 * Un seul PointSet partagé : c'est ce qui empêche un corail de pousser dans
 * une touffe d'herbier et un oyat de sortir d'un galet. Le rayon effectif est
 * le max des deux — donc les grosses espèces gagnent, ce qui est le bon ordre
 * de priorité si on les sème EN PREMIER.
 */
export function scatterBiota(heights, shoreD, seed = 20260901, quality = 1.0) {
  const rng = mulberry32(seed);
  const set = new PointSet(0.35);
  const out = {};

  const x0 = ORIGIN_X, z0 = ORIGIN_Z;
  const x1 = ORIGIN_X + NX * VOXEL, z1 = ORIGIN_Z + NZ * VOXEL;

  const at = (x, z) => {
    const ix = clamp(Math.round((x - ORIGIN_X) / VOXEL - 0.5), 0, NX - 1);
    const iz = clamp(Math.round((z - ORIGIN_Z) / VOXEL - 0.5), 0, NZ - 1);
    return ix + NX * iz;
  };
  const slopeAt = (c) => {
    const ix = c % NX, iz = (c / NX) | 0;
    if (ix < 1 || iz < 1 || ix > NX - 2 || iz > NZ - 2) return 9;
    const gx = (heights[c + 1] - heights[c - 1]) * 0.5 / VOXEL;
    const gz = (heights[c + NX] - heights[c - NX]) * 0.5 / VOXEL;
    return Math.hypot(gx, gz);
  };

  // On sème du plus gros au plus petit : les corails réservent leur place,
  // l'herbier remplit les interstices. L'ordre inverse donnerait un tapis
  // uniforme dans lequel aucun corail ne pourrait plus se poser.
  const ordered = [...SPECIES].sort((a, b) => b.minDist - a.minDist);

  for (const sp of ordered) {
    const list = [];
    const target = Math.round(sp.count * quality);
    const accept = (x, z) => {
      if (x < x0 || x > x1 || z < z0 || z > z1) return false;
      const c = at(x, z);
      const d = shoreD[c];
      if (d < sp.d[0] || d > sp.d[1]) return false;
      if (slopeAt(c) > sp.slope) return false;
      return true;
    };
    const emit = (x, z, edge = 0) => {
      if (list.length >= target) return;
      if (!set.tryAdd(x, z, sp.minDist, { sp: sp.id })) return;
      const c = at(x, z);
      const [smin, smax] = sp.sizeVar || [0.78, 1.28];
      // Les individus de bord de massif sont plus petits (compétition).
      const size = smin + (smax - smin) * rng() * (1 - edge * 0.45);
      list.push({
        x, y: heights[c], z,
        rot: rng() * Math.PI * 2,
        scale: size,
        phase: rng() * Math.PI * 2,
        stiff: 0.72 + rng() * 0.62,
        tint: rng(),
      });
    };

    switch (sp.pattern) {
      case 'carpet': {
        // Grille jitterée : couverture régulière, aucun trou visible, très
        // rapide. Le pas est calé pour dépasser légèrement la cible, le
        // PointSet et le test de zone font le reste du tri.
        const step = sp.minDist * 0.92;
        for (let z = z0; z < z1 && list.length < target; z += step) {
          for (let x = x0; x < x1 && list.length < target; x += step) {
            const jx = x + (rng() - 0.5) * step * 1.4;
            const jz = z + (rng() - 0.5) * step * 1.4;
            if (!accept(jx, jz)) continue;
            // Densité modulée par le bruit : un herbier a des clairières
            if (rng() > 0.55 + 0.45 * Math.sin(jx * 1.7) * Math.cos(jz * 1.9)) continue;
            emit(jx, jz);
          }
        }
        break;
      }
      case 'cluster': {
        scatterClustered(rng, Math.max(2, Math.round(sp.clusters * quality)),
          target / Math.max(1, sp.clusters), sp.sigma,
          [x0, z0, x1, z1], accept, emit);
        break;
      }
      case 'strand': {
        // Cordon de laisse de mer : la densité est une cloche centrée sur la
        // ligne de haute mer. Un coquillage ne se dépose pas au hasard, il est
        // abandonné là où la vague s'arrête.
        let guard = 0;
        while (list.length < target && guard++ < target * 45) {
          const x = x0 + rng() * (x1 - x0);
          const z = z0 + rng() * (z1 - z0);
          if (!accept(x, z)) continue;
          const d = shoreD[at(x, z)];
          const w = Math.exp(-Math.pow((d - sp.peak) / (0.55 / sp.sharp), 2));
          // 22 % de fond diffus : quelques coquillages traînent hors cordon
          if (rng() > w * 0.78 + 0.22) continue;
          emit(x, z);
        }
        break;
      }
      default: {
        let guard = 0;
        while (list.length < target && guard++ < target * 45) {
          const x = x0 + rng() * (x1 - x0);
          const z = z0 + rng() * (z1 - z0);
          if (accept(x, z)) emit(x, z);
        }
      }
    }
    out[sp.id] = list;
  }
  return out;
}
```

### 5.4 Réaction au creusement et à la marée

Le mécanisme existe déjà : `Props.update()` re-teste une tranche d'objets par
frame contre `field.surfaceHeightAt()` et les fait descendre ou remonter.
Il faut trois compléments.

**1. Un corail ne « coule » pas comme un coquillage.** Une colonie est
cimentée. Si le sol descend de plus de 15 cm sous elle, elle ne suit pas
gentiment : elle **bascule**. Sinon on obtient des coraux qui s'enfoncent dans
un trou comme des bouées.

```js
// Dans Props.update(), pour les espèces marquées `rigid: true`
const drop = it.y - surf;
if (drop > 0.15 && !it.toppled) {
  it.toppled = true;
  it.tilt = 0.9 + Math.random() * 0.6;       // couché
  it.nx = Math.random() - 0.5;
  it.nz = Math.random() - 0.5;
  it.y = surf;                                // il tombe d'un coup
  dirty = true;
} else if (!it.toppled) {
  // suivi normal, mais lent : le socle résiste avant de céder
  ...
}
```

**2. Un corail découvert à marée basse reste visible.** C'est acquis
gratuitement : les props ne sont pas rendus par le shader d'eau, ils sont
toujours dessinés. Le seul risque était que l'absorption les fasse disparaître.
Le shader §3.5 traite explicitement le cas `d < 0.0015` : au lieu de ne rien
faire, il applique un **assombrissement d'humidité** décroissant depuis la
laisse de haute mer (`uLastHigh`). Résultat : à marée basse le récif émerge,
sombre, saturé et luisant — un des plus beaux moments de la boucle de jeu.

```js
// Game.js, une fois par frame
const shared = this.biota.shared;
shared.uLastHigh.value = Math.max(
  water.seaLevel,
  shared.uLastHigh.value - dt * 0.02   // la trace d'humidité sèche lentement
);
```

**3. Creuser détruit ce qui est dessus.** `removeNear(x, y, z, radius)` existe
déjà. Il suffit de l'appeler depuis `Brush.js` sur le coup de pelle, avec un
rayon un peu plus grand que le pinceau. À ajouter : renvoyer la liste des
espèces détruites, pour que le HUD puisse dire « vous avez cassé du corail » —
un petit signal moral qui va bien avec le ton du jeu.

**4. La marée qui monte ne doit rien déplacer.** Aucune action : l'eau ne
modifie pas `surfaceH`, seulement l'érosion le fait, et elle est déjà prise en
compte par le suivi de terrain.

---

## 6. Performance

### 6.1 Budget d'instances

À qualité 1,0 (préréglage « Élevé »). Les colonnes de droite sont les coûts
réels : `tris` = instances × triangles de la géométrie.

| Espèce | Instances | Tris/inst. | Total tris | Draw calls | Ombre |
|---|---|---|---|---|---|
| Herbier | 2 200 | 72 | 158 400 | 2 | non |
| Algues | 520 | 84 | 43 680 | 2 | non |
| Algues échouées | 160 | 84 | 13 440 | 1 | non |
| Acropora rose | 82 | 320 | 26 240 | 1 | oui |
| Acropora orange | 62 | 320 | 19 840 | 1 | oui |
| Acropora crème | 36 | 320 | 11 520 | 1 | oui |
| Acropora violette | 24 | 320 | 7 680 | 1 | oui |
| Cerveau | 70 | 80 | 5 600 | 2 | oui |
| Tabulaire | 20 | 110 | 2 200 | 1 | oui |
| Gorgone | 70 | 130 | 9 100 | 2 | non |
| Rocher immergé | 80 | 80 | 6 400 | 2 | oui |
| Oursin | 80 | 68 | 5 440 | 2 | non |
| Étoile de mer | 40 | 80 | 3 200 | 1 | non |
| Bernard-l'ermite | 24 | 150 | 3 600 | 1 | non |
| Coquillage | 420 | 204 | 85 680 | 3 | non |
| Galet | 500 | 20 | 10 000 | 3 | oui |
| Bois flotté | 12 | 60 | 720 | 1 | oui |
| Oyat | 600 | 132 | 79 200 | 2 | oui |
| Buisson | 80 | 80 | 6 400 | 2 | oui |
| Plante grasse | 60 | 48 | 2 880 | 1 | oui |
| Drapeaux (joueur) | 120 | 40 | 4 800 | 2 | oui |
| **Total** | **5 260** | — | **≈ 506 000** | **34** | |

**Passe d'ombre.** Elle rejoue toute la géométrie. En excluant l'herbier, les
algues, les coquillages, les oursins, les gorgones et les étoiles (leur ombre
est soit sous l'eau — donc invisible — soit trop petite pour se lire), la passe
d'ombre ne traite plus que ~180 000 triangles. C'est le gain le plus rentable
du document : deux lignes de `castShadow = false`.

**Préréglages de qualité.** Le facteur s'applique aux `count` de `SPECIES` :

| Préréglage | Facteur | Instances | Triangles |
|---|---|---|---|
| Bas | 0,35 | 1 840 | 177 000 |
| Moyen | 0,65 | 3 420 | 329 000 |
| Élevé | 1,00 | 5 260 | 506 000 |
| Ultra | 1,45 | 7 630 | 734 000 |

### 6.2 LOD : ce qui marche sur un diorama

Le LOD classique par distance à la caméra n'a **presque aucun sens ici**. Le
domaine fait 10 m ; la caméra est entre 1,5 m et 8 m. L'écart de taille à
l'écran entre l'objet le plus proche et le plus loin est d'un facteur cinq, pas
de mille. Un système de LOD par instance coûterait plus en gestion qu'il ne
rapporte.

Ce qui marche, en revanche, c'est le **LOD global de vue** : le joueur regarde
soit son château de près (les objets font 60 px), soit le diorama entier (ils
font 6 px). Un seul basculement, piloté par la distance caméra–centre :

```js
/**
 * Deux jeux de géométries par espèce lourde, un seul basculement global.
 *
 * Quand la caméra recule au-delà de 5 m, l'herbier passe de 9 brins à 4 et les
 * acropora de 4 niveaux à 3. Le basculement est invisible parce qu'à cette
 * distance une touffe fait six pixels — et il divise par deux la charge
 * géométrique dans la vue où l'on voit le PLUS d'objets à la fois.
 */
update(camera) {
  const dist = camera.position.distanceTo(this.center);
  const wantFar = dist > 5.0;
  if (wantFar === this.farLod) return;         // hystérésis via deux seuils
  this.farLod = wantFar;
  for (const k of this.kinds) {
    if (!k.geoFar) continue;
    k.mesh.geometry = wantFar ? k.geoFar : k.geoNear;
  }
}
```

Les géométries lointaines : `makeSeagrassTuft({ blades: 4 })` (32 tris),
`makeBranchingCoral({ levels: 3, budget: 140 })`, `makeMarramTuft({ blades: 5 })`
(60 tris), `makeSpiralShell({ steps: 9, sides: 5 })` (90 tris). Gain : −52 %
de triangles en vue large.

Pas d'impostors, pas de billboards. Sur un diorama vu sous tous les angles, y
compris rasants, un billboard se trahit immédiatement — et de toute façon nos
géométries sont déjà moins chères que la paire de triangles + le texel fetch
d'un impostor bien fait.

### 6.3 Culling

Avec `frustumCulled = false` et 34 draw calls, on soumet toujours tout. En vue
rapprochée, c'est du gâchis : la moitié du domaine est hors champ.

Deux niveaux, par ordre de rentabilité :

**a) Culling grossier par espèce (gratuit).** Remettre
`mesh.frustumCulled = true` et fournir une `boundingSphere` correcte **par
InstancedMesh** — pas la sphère de la géométrie, celle de l'ensemble des
instances. Nos espèces sont zonées : l'herbier occupe un coin de 4 m, les oyats
le coin opposé. En vue rapprochée sur le château, la moitié des espèces sont
entièrement rejetées d'un seul test.

```js
refresh(kindIndex) {
  ...
  // Sphère englobante des INSTANCES (three ne la calcule pas tout seul
  // correctement quand on modifie mesh.count à la main).
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const it of k.items) {
    v.set(it.x, it.y, it.z);
    box.expandByPoint(v);
  }
  box.expandByScalar(k.radius);         // rayon max de la géométrie × scale
  k.mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  k.mesh.frustumCulled = true;
}
```

**b) Culling par bloc, pour l'herbier seul.** L'herbier représente 31 % des
triangles à lui tout seul. On trie ses instances par bloc de 1,28 m (une case
de 32 voxels), on garde les blocs contigus dans le buffer, et on n'émet que la
plage de blocs visibles en jouant sur `mesh.count` — quitte à faire deux ou
trois `InstancedMesh` pour couvrir des plages non contiguës. Gain typique en
vue rapprochée : −60 % sur l'herbier, soit −95 000 triangles.

Ne pas aller plus loin. Le culling par instance sur 5 000 objets coûte plus en
JavaScript qu'il ne rapporte en GPU sur un domaine de 10 m.

### 6.4 `InstancedMesh` ou `BatchedMesh` en r185 ?

Les deux rendent en un appel avec un seul matériau. La différence est que
`BatchedMesh` accepte **plusieurs géométries** dans le même appel, et qu'il
gère lui-même le tri et le culling par instance via `multiDraw`.

Mais l'implémentation actuelle de `BatchedMesh` a émulé l'instanciation en
répétant les paramètres de `multiDrawArrays` au lieu d'utiliser
`multiDraw*Instanced` (déprécié entre-temps) — ce qui la rend **plus lente
qu'`InstancedMesh` quand on dessine beaucoup de copies d'une même géométrie**.

D'où la règle :

| Cas | Choix | Pourquoi |
|---|---|---|
| 1 géométrie × beaucoup d'instances (herbier 2 200, oyats 600, galets 500) | **`InstancedMesh`** | c'est exactement son cas nominal, et il est plus rapide |
| 2 à 4 géométries × beaucoup d'instances | **plusieurs `InstancedMesh`** | 4 draw calls, c'est gratuit |
| Beaucoup de géométries × peu d'instances chacune (les 4 teintes × 3 variantes d'acropora = 12 géométries × ~15 instances) | **`BatchedMesh`** | 12 draw calls → 1, et le culling par instance vient avec |

**Recommandation.** Version 1 : tout en `InstancedMesh`, 34 draw calls. C'est
sous le budget d'un ordre de grandeur ; 34 appels ne se voient sur aucune
machine. Version 2, si et seulement si on multiplie les variantes au-delà de
trois par espèce : regrouper la famille « coraux » (4 teintes × 3 formes ×
2 LOD = 24 géométries) dans un seul `BatchedMesh` avec
`perObjectFrustumCulled = true` et `sortObjects = true`. Le tri est un bonus
réel pour les gorgones, qui sont semi-transparentes.

```js
// Esquisse pour la version 2
const batch = new THREE.BatchedMesh(
  /* maxInstanceCount */ 300,
  /* maxVertexCount   */ 24 * 400 * 3,
  /* maxIndexCount    */ 0,
  coralMaterial
);
batch.perObjectFrustumCulled = true;
batch.sortObjects = true;
const geoIds = CORAL_GEOMETRIES.map((g) => batch.addGeometry(g));
for (const it of items) {
  const id = batch.addInstance(geoIds[it.variant]);
  batch.setMatrixAt(id, it.matrix);
  batch.setColorAt(id, it.color);
}
```

Attention : `BatchedMesh` a besoin de géométries **de même signature
d'attributs**. Notre `GeoBuilder` produit toujours `position/normal/aFlex` :
c'est compatible par construction, à condition de ne jamais mélanger indexé et
non indexé.

### 6.5 Coût CPU

| Poste | Coût | Fréquence |
|---|---|---|
| Génération des géométries | ~25 ms | une fois au chargement |
| Semis (`scatterBiota`) | ~12 ms | au chargement + regénération |
| Upload de `WaterField` | 256×256×4 floats = 1 Mo | par frame |
| `Props.update` (suivi de terrain) | ~880 objets testés/frame (stride 6) | par frame |
| Upload des `instanceMatrix` sales | seulement les espèces marquées `dirty` | par frame |

Le seul point à surveiller est l'upload de `WaterField` : 1 Mo par frame en
`FloatType`. En `HalfFloatType` c'est 512 ko, et la précision (11 bits de
mantisse sur une plage de 4 m, soit 2 mm) est largement suffisante. À faire
dès qu'on constate une pression sur la bande passante — et à ne pas faire
avant, `Float32Array` est plus simple à écrire depuis JS.

Ne PAS ré-uploader la texture si l'eau n'a pas bougé (marée statique + pas de
ressac) : un drapeau `water.dirty` économise un mégaoctet par frame en mode
photo.

---

## 7. Plan d'intégration

### 7.1 Ce qui change dans `Props.js`, ce qui reste

`Props.js` fait aujourd'hui trois choses bien : il génère des géométries en
code, il les instancie, et il **fait suivre le terrain aux objets**. Cette
troisième fonction est précieuse et déjà écrite. On ne la touche pas.

Ce qui doit changer, c'est que le fichier mélange trois responsabilités :
la bibliothèque de formes, le registre d'espèces, et le moteur d'instances.
Avec vingt espèces au lieu de six, ça devient illisible.

**Découpage proposé :**

| Fichier | Rôle | Statut |
|---|---|---|
| `src/world/Biota.js` | `GeoBuilder`, `mulberry32`, toutes les fonctions `makeXxx` | **nouveau** (~500 lignes) |
| `src/world/PointSet.js` | hachage spatial, distance minimale | **nouveau** (~50 lignes) |
| `src/world/BiomeScatter.js` | table `SPECIES`, `scatterBiota`, Neyman–Scott | **nouveau** (~200 lignes) |
| `src/render/BiotaMaterial.js` | `createBiotaMaterial`, chunks GLSL | **nouveau** (~150 lignes) |
| `src/render/WaterField.js` | texture de champ partagée | **nouveau** (~50 lignes) |
| `src/render/shaders/water-optics.js` | `SIGMA`, caustiques, couleurs d'eau | **nouveau** (~40 lignes) |
| `src/render/Props.js` | moteur d'instances, suivi de terrain, pose/suppression, sauvegarde | **refondu** |
| `src/world/BeachGenerator.js` | `pickScatterPoints` supprimée, remplacée par l'appel à `scatterBiota` | **allégé** |

**Ce qui reste identique dans `Props.js` :**
- `add`, `place`, `removeNear`, `refresh`, `refreshAll`
- toute la logique de `update(dt)` (curseur `settleCursor`, stride, remontée / chute)
- `serialize` / `deserialize` (à étendre : on ajoute `phase` et `tint`)
- l'API vue du reste du jeu : `props.place(kindIndex, ...)`, `props.count`

**Ce qui change dans `Props.js` :**

```js
// AVANT
const KINDS = [
  { id: 'flagRed', color: 0xd9463c, kind: 'flag', scale: 1.0 },
  ...
];

// APRÈS : le registre est construit à partir de la table SPECIES, et chaque
// espèce déclare sa géométrie, sa palette, son mode d'animation.
import { SPECIES } from '../world/BiomeScatter.js';
import * as Biota from '../world/Biota.js';
import { createBiotaMaterial } from './BiotaMaterial.js';

const KIND_DEFS = {
  seagrass: {
    geo: (s) => Biota.makeSeagrassTuft(s, { blades: 9 }),
    geoFar: (s) => Biota.makeSeagrassTuft(s, { blades: 4 }),
    base: 0x2f7a45, tip: 0x7fa84a, mode: 'water', height: 0.115,
    doubleSide: true, shadow: false, max: 2400,
  },
  coralPink: {
    geo: (s) => Biota.makeBranchingCoral(s, Biota.ACROPORA_VARIANTS[0]),
    geoFar: (s) => Biota.makeBranchingCoral(s, { ...Biota.ACROPORA_VARIANTS[0], levels: 3, budget: 140 }),
    base: 0xf2648f, tip: 0xffc9dc, mode: 'static', rigid: true,
    shadow: true, max: 110,
  },
  marram: {
    geo: (s) => Biota.makeMarramTuft(s, { blades: 11 }),
    geoFar: (s) => Biota.makeMarramTuft(s, { blades: 5, spikes: 0 }),
    base: 0x9c8f4e, tip: 0xd9c982, mode: 'wind', height: 0.26,
    doubleSide: true, shadow: true, submersible: false, max: 700,
  },
  // ... une entrée par espèce
};
```

Les trois ajouts structurels au moteur :

```js
// 1. Attributs d'instance
const phases = new Float32Array(max);
const stiffs = new Float32Array(max);
mesh.geometry.setAttribute('aPhase',
  new THREE.InstancedBufferAttribute(phases, 1));
mesh.geometry.setAttribute('aStiff',
  new THREE.InstancedBufferAttribute(stiffs, 1));
// (à re-poser quand on bascule geoNear <-> geoFar : les attributs d'instance
//  vivent sur la géométrie, pas sur le mesh. C'est LE piège du LOD par
//  échange de géométrie.)

// 2. Couleur par instance : natif
mesh.setColorAt(i, jitterColor(def.base, rnd));
mesh.instanceColor.needsUpdate = true;

// 3. Ombres sélectives
mesh.castShadow = def.shadow === true;
mesh.receiveShadow = def.mode !== 'water';   // sous l'eau l'ombre ne se lit pas
```

Et `seed()` devient :

```js
seed(scatter) {
  if (!scatter) return;
  for (const id in scatter) {
    const ki = this.indexOf(id);
    if (ki < 0) continue;
    for (const p of scatter[id]) {
      const it = this.add(ki, p.x, p.y, p.z, p.rot, p.scale);
      if (it) { it.phase = p.phase; it.stiff = p.stiff; it.tint = p.tint; }
    }
  }
  this.refreshAll();
}
```

### 7.2 Ordre d'implémentation, par rapport qualité / effort

Classé par **gain visuel par heure de travail**. Les trois premiers points
transforment l'image ; le reste l'enrichit.

| # | Étape | Effort | Gain | Pourquoi maintenant |
|---|---|---|---|---|
| **1** | `WaterField` + absorption/caustiques dans le matériau des props existants | ½ j | ★★★★☆ | Rien de nouveau à modéliser. Les coquillages et galets déjà immergés se mettent instantanément à « baigner » dans l'eau au lieu d'y flotter. C'est la brique dont tout le reste dépend. |
| **2** | `GeoBuilder` + herbier + algues + semis en tapis | 1 j | ★★★★★ | **Le plus gros gain du document.** 2 700 objets verts sous une eau claire : le fond cesse d'être vide. À faire avant les coraux — un récif posé sur du sable nu a l'air d'une maquette. |
| **3** | Ondulation sous-marine (`swayUnderwater`) | ½ j | ★★★★★ | Vingt lignes de GLSL. Le fond passe de « décor » à « milieu ». Aucun autre poste n'a ce ratio. |
| **4** | Corail branchu (3 variantes × 4 teintes) + Neyman–Scott | 1,5 j | ★★★★★ | Le « wow ». C'est la silhouette qui dit « récif tropical ». Les amas sont indispensables : semé uniformément, le même corail a l'air d'un champ de brocolis. |
| **5** | Rochers immergés + corail cerveau | ½ j | ★★★☆☆ | Structure et ombres portées. Donne l'échelle et casse la platitude du fond. |
| **6** | Vent saccadé + oyats refaits + buissons ronds | 1 j | ★★★★☆ | La partie terrestre est aujourd'hui moins mauvaise que le fond, mais l'oyat actuel est raide. Le contraste eau lente / vent saccadé est un plaisir en soi. |
| **7** | Gorgone + corail tabulaire | ½ j | ★★★☆☆ | Verticalité et ombre projetée. Peu d'instances, gros effet par instance. |
| **8** | Coquillage en spirale logarithmique (3 variantes) | ½ j | ★★★☆☆ | 420 instances déjà en place : on remplace juste la géométrie. Meilleur gain/effort de la partie terrestre. |
| **9** | Oursins, étoiles variées, bernard-l'ermite | ½ j | ★★☆☆☆ | Ponctuation. Le bernard-l'ermite mérite une petite animation de déplacement plus tard. |
| **10** | Plantes grasses, bois flotté, algues échouées | ½ j | ★★☆☆☆ | Habillage de la laisse de mer, zone aujourd'hui pauvre. |
| **11** | Ombres sélectives + `boundingSphere` par espèce | 2 h | — | Optimisation pure, mais à faire dès l'étape 4 : c'est là que le budget d'ombre explose. |
| **12** | LOD global de vue | ½ j | — | À faire quand la vue large tombe sous 60 fps, pas avant. |
| **13** | `BatchedMesh` pour la famille corail | 1 j | — | Uniquement si le nombre de variantes dépasse 3 par espèce. |

**Total : environ 8 jours** pour la totalité, dont **2 jours** pour les étapes
1 à 3 qui portent déjà 70 % du gain visuel.

### 7.3 Points de vigilance

1. **Les attributs d'instance vivent sur la géométrie.** `aPhase` et `aStiff`
   sont des `InstancedBufferAttribute` posés sur `mesh.geometry`. Si le LOD
   échange la géométrie, il faut re-poser les attributs sur la nouvelle. Le
   plus simple est de les créer une fois et de les partager entre `geoNear` et
   `geoFar` — three accepte le même `BufferAttribute` sur deux géométries.

2. **`onBeforeCompile` et le cache de programmes.** Sans
   `customProgramCacheKey`, three réutilise le programme compilé du premier
   matériau pour tous les suivants, et toutes les espèces héritent du mode
   d'animation de la première. Le bug est silencieux et déroutant. La clé doit
   inclure `BIOTA_MODE` et `submersible`.

3. **Le remplacement de `#include <project_vertex>` casse le shadow map.** Les
   shaders de profondeur (`depth`, `distanceRGBA`) sont d'autres programmes,
   qui ne passent pas par notre `onBeforeCompile`. Résultat : les ombres des
   plantes animées sont figées à la position de repos. Deux réponses : soit
   `castShadow = false` (c'est notre cas pour l'herbier et les algues), soit
   fournir un `customDepthMaterial` avec la même déformation. Pour les oyats,
   qui portent une vraie ombre, il faut le `customDepthMaterial`.

4. **`computeBoundingSphere` après chaque `refresh`** est déjà fait mais coûte
   O(n) sur `instanceMatrix`. Avec 2 200 instances d'herbier ré-évaluées à
   chaque chute de sable, ça se sent. Remplacer par le calcul incrémental sur
   la boîte des `items` (voir §6.3), qui est O(n) sur des objets JS mais sans
   lecture de buffer typé.

5. **La sauvegarde grossit.** 5 260 objets × 7 nombres, c'est ~35 000 valeurs.
   Ne pas sérialiser la biote générée : elle est **déterministe**. Sauvegarder
   la graine et la liste des objets *supprimés* (creusement) suffit — quelques
   dizaines d'entrées au lieu de trente-cinq mille.

---

## 8. Sources

- [Procedural generation and real-time rendering of a marine ecosystem — Springer / FITEE](https://link.springer.com/article/10.1631/jzus.C1300342)
- [Procedurally Generated Coral — Williams College CS371](https://www.cs.williams.edu/~morgan/cs371-f16/gallery/4-midterm/coral/report.md.html)
- [Inverse Procedural Modeling of Branching Structures by Inferring L-Systems — ACM TOG](https://dl.acm.org/doi/fullHtml/10.1145/3394105)
- [Coral growth forms — Reef Builders](https://reefbuilders.com/2019/01/26/spot-coral-diversity-growth-forms/)
- [NOAA — Corals Tutorial: growth](https://oceanservice.noaa.gov/education/tutorial_corals/coral03_growth.html)
- [Coral Trait Database — growth form (Veron 2000)](https://www.coraltraits.org/methodologies/55)
- [Gorgonia ventalina — structure en treillis plan](https://en.wikipedia.org/wiki/Gorgonia_ventalina)
- [Modeling seashells — Fowler, Meinhardt, Prusinkiewicz, SIGGRAPH 92](https://algorithmicbotany.org/papers/shells.sig92.pdf)
- [Seashell surface — modèle de Raup](https://en.wikipedia.org/wiki/Seashell_surface)
- [A Mathematical Model for Mollusc Shells Based on Parametric Surfaces — MDPI Diversity](https://www.mdpi.com/1424-2818/15/3/431)
- [Fast Poisson Disk Sampling in Arbitrary Dimensions — Bridson, SIGGRAPH 2007](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf)
- [Red Blob Games — 2D point sets : jittered grid vs Poisson](https://www.redblobgames.com/x/1830-jittered-grid/)
- [Neyman–Scott process — Wikipedia](https://en.wikipedia.org/wiki/Neyman%E2%80%93Scott_process)
- [Cyanilux — GPU Instanced Grass Breakdown](https://www.cyanilux.com/tutorials/gpu-instanced-grass-breakdown/)
- [al-ro — Grass instancing et animation de vent](https://al-ro.github.io/projects/grass/)
- [IceFall Games — Wind animations for vegetation](https://mtnphil.wordpress.com/2011/10/18/wind-animations-for-vegetation/)
- [GPUOpen — Procedural grass rendering with mesh shaders](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
- [Dynamic Kelp in Unity — instanciation indirecte pour les algues](https://seasaltcrackers.wordpress.com/2021/09/24/dynamic-kelp-in-unity/)
- [three.js forum — How to choose between InstancedMesh and BatchedMesh?](https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221)
- [Codrops — BatchedMesh and post processing with WebGPURenderer](https://tympanus.net/codrops/2024/10/30/interactive-3d-with-three-js-batchedmesh-and-webgpurenderer/)
- [three.js issue #31935 — BatchedMesh support for multiDraw*Instanced](https://github.com/mrdoob/three.js/issues/31935)
- [three.js forum — Per-instance frustum culling on InstancedMesh](https://discourse.threejs.org/t/ideas-on-performing-fast-per-instance-frustum-culling-on-instancedmesh/85156)
- [VR Me Up — Three.js InstancedMesh performance optimizations](https://vrmeup.com/devlog/devlog_10_threejs_instancedmesh_performance_optimizations.html)
- [Martin Renou — Real-time rendering of water caustics (three.js)](https://medium.com/@martinRenou/real-time-rendering-of-water-caustics-59cda1d74aa)
- [Visual enhancement and 3D representation for underwater scenes (Beer–Lambert, atténuation par longueur d'onde)](https://arxiv.org/pdf/2505.01869)
- [Ammophila arenaria — zonation dunaire et distribution](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5606859/)
- [Coastal Vegetation Zonation and Dune Morphology in Mediterranean Ecosystems](https://www.researchgate.net/publication/232672574_Coastal_Vegetation_Zonation_and_Dune_Morphology_in_Some_Mediterranean_Ecosystems)
- [Filmora — Coral reef color palettes (codes hex)](https://filmora.wondershare.com/video-creative-tips/coral-reef-color-palette.html)
- [Simplygon — Optimizing vegetation with reduction and billboard pipeline](https://www.simplygon.com/posts/04a89922-2cd3-4ea6-84af-19cf453c05c2)
- [Sandcastle — page Steam (référence visuelle)](https://store.steampowered.com/app/3216520/Sandcastle/)
