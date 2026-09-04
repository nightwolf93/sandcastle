/**
 * Géométries procédurales de la vie sous-marine.
 *
 * Tout est généré en code, sans aucun fichier d'asset, et chaque espèce reste
 * sous ~320 triangles : elles sont instanciées par milliers.
 *
 * Le principe qui guide chaque forme : ce qu'on voit d'un récif à travers deux
 * mètres d'eau turquoise, ce n'est pas du détail, c'est une SILHOUETTE et une
 * COULEUR. Une gorgone doit se lire comme un éventail, un acropora comme une
 * touffe de doigts. Modéliser plus finement serait invisible et coûteux.
 *
 * Les brins souples (herbier, algues) sont construits avec leur base à y=0 et
 * leur hauteur normalisée dans l'attribut `aSway` : le vertex shader s'en sert
 * pour faire onduler la pointe sans bouger le pied.
 */

import * as THREE from 'three';

/** Générateur pseudo-aléatoire déterministe : la même touffe à chaque lancement. */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Assemble une liste de géométries en une seule, non indexée, avec un
 * attribut `aSway` (0 au pied, 1 à la pointe) reconstruit depuis la hauteur.
 */
function finalize(pos, nrm, sway) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  if (nrm && nrm.length === pos.length) {
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  } else {
    g.computeVertexNormals();
  }
  g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(sway), 1));
  return g;
}

/** Ajoute un ruban plat (une lame) le long d'une courbe. */
function ribbon(pos, sway, pts, widths, side) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay, az] = pts[i];
    const [bx, by, bz] = pts[i + 1];
    const wa = widths[i], wb = widths[i + 1];
    const sa = i / (pts.length - 1), sb = (i + 1) / (pts.length - 1);
    const [sx, , sz] = side;
    pos.push(
      ax - sx * wa, ay, az - sz * wa,
      ax + sx * wa, ay, az + sz * wa,
      bx + sx * wb, by, bz + sz * wb,
      ax - sx * wa, ay, az - sz * wa,
      bx + sx * wb, by, bz + sz * wb,
      bx - sx * wb, by, bz - sz * wb
    );
    sway.push(sa, sa, sb, sa, sb, sb);
  }
}

// ---------------------------------------------------------------------------
// HERBIER — c'est LE manque visuel : un tapis de brins fins et denses.
// ---------------------------------------------------------------------------

export function makeSeagrass(seed = 11) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];
  const N = 11;
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const lean = 0.35 + rnd() * 0.45;
    const h = 0.14 + rnd() * 0.20;
    const w0 = 0.006 + rnd() * 0.003;
    const dx = Math.cos(a), dz = Math.sin(a);
    const ox = (rnd() - 0.5) * 0.05, oz = (rnd() - 0.5) * 0.05;
    const pts = [], widths = [];
    const SEG = 4;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      // Les rubans d'herbier se couchent : la courbure croît avec la hauteur.
      pts.push([ox + dx * lean * t * t * h, t * h, oz + dz * lean * t * t * h]);
      widths.push(w0 * (1 - 0.75 * t));
    }
    ribbon(pos, sway, pts, widths, [-dz, 0, dx]);
  }
  return finalize(pos, null, sway);
}

/** Touffe d'algues : lames plus larges, plus courtes, plus molles. */
export function makeAlgae(seed = 23) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2;
    const lean = 0.6 + rnd() * 0.5;
    const h = 0.10 + rnd() * 0.12;
    const w0 = 0.016 + rnd() * 0.010;
    const dx = Math.cos(a), dz = Math.sin(a);
    const pts = [], widths = [];
    const SEG = 4;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      pts.push([dx * lean * t * t * h, t * h * (1 - 0.15 * t), dz * lean * t * t * h]);
      widths.push(w0 * (0.55 + 0.45 * Math.sin(t * Math.PI)));
    }
    ribbon(pos, sway, pts, widths, [-dz, 0, dx]);
  }
  return finalize(pos, null, sway);
}

// ---------------------------------------------------------------------------
// CORAUX
// ---------------------------------------------------------------------------

/**
 * Corail branchu (acropora) : arbre récursif à branches épaisses vers la base.
 * On empile de courts prismes plutôt que des cylindres complets — à cette
 * échelle, six faces suffisent et le budget triangle est divisé par trois.
 */
export function makeBranchCoral(seed = 31) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];

  function segment(x, y, z, dx, dy, dz, len, rad) {
    const ex = x + dx * len, ey = y + dy * len, ez = z + dz * len;
    // Repère perpendiculaire
    let ux = -dz, uy = 0, uz = dx;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const S = 5;
    for (let i = 0; i < S; i++) {
      const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const r2 = rad * 0.62;
      const p = (px, py, pz, r, c, s) => [
        px + (ux * c + vx * s) * r,
        py + (uy * c + vy * s) * r,
        pz + (uz * c + vz * s) * r,
      ];
      const A = p(x, y, z, rad, c0, s0), B = p(x, y, z, rad, c1, s1);
      const C = p(ex, ey, ez, r2, c1, s1), D = p(ex, ey, ez, r2, c0, s0);
      pos.push(...A, ...B, ...C, ...A, ...C, ...D);
      for (let k = 0; k < 6; k++) sway.push(0);
    }
    return [ex, ey, ez];
  }

  function grow(x, y, z, dx, dy, dz, len, rad, depth) {
    const [ex, ey, ez] = segment(x, y, z, dx, dy, dz, len, rad);
    if (depth <= 0 || rad < 0.006) return;
    const n = 2 + (rnd() < 0.35 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const spread = 0.45 + rnd() * 0.35;
      let nx = dx + Math.cos(a) * spread;
      let ny = dy + 0.35 + rnd() * 0.3;
      let nz = dz + Math.sin(a) * spread;
      const l = Math.hypot(nx, ny, nz) || 1;
      grow(ex, ey, ez, nx / l, ny / l, nz / l, len * (0.68 + rnd() * 0.15),
        rad * 0.66, depth - 1);
    }
  }

  grow(0, 0, 0, 0, 1, 0, 0.075, 0.028, 3);
  return finalize(pos, null, sway);
}

/** Corail cerveau : demi-sphère aplatie creusée de sillons. */
export function makeBrainCoral(seed = 41) {
  const g = new THREE.SphereGeometry(0.085, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    // Sillons méandriformes : deux fréquences croisées.
    const groove = Math.sin(a * 7 + r * 40) * Math.cos(r * 26) * 0.055;
    const k = 1 + groove;
    p.setXYZ(i, x * k, y * 0.62 * k, z * k);
  }
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}

/** Corail tabulaire : un plateau porté par un pied court. */
export function makeTableCoral(seed = 53) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];
  const R = 0.115, H = 0.05;
  const S = 14;
  for (let i = 0; i < S; i++) {
    const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
    const w0 = 1 + (rnd() - 0.5) * 0.22, w1 = 1 + (rnd() - 0.5) * 0.22;
    const r0 = R * w0, r1 = R * w1;
    const x0 = Math.cos(a0) * r0, z0 = Math.sin(a0) * r0;
    const x1 = Math.cos(a1) * r1, z1 = Math.sin(a1) * r1;
    // Dessus du plateau, legerement bombe
    pos.push(0, H + 0.012, 0, x0, H, z0, x1, H, z1);
    // Dessous
    pos.push(0, H - 0.014, 0, x1, H - 0.004, z1, x0, H - 0.004, z0);
    // Tranche
    pos.push(x0, H, z0, x0, H - 0.004, z0, x1, H - 0.004, z1);
    pos.push(x0, H, z0, x1, H - 0.004, z1, x1, H, z1);
    for (let k = 0; k < 12; k++) sway.push(0);
  }
  // Pied
  const S2 = 6, pr = 0.022;
  for (let i = 0; i < S2; i++) {
    const a0 = (i / S2) * Math.PI * 2, a1 = ((i + 1) / S2) * Math.PI * 2;
    const x0 = Math.cos(a0) * pr, z0 = Math.sin(a0) * pr;
    const x1 = Math.cos(a1) * pr, z1 = Math.sin(a1) * pr;
    pos.push(x0, 0, z0, x1, 0, z1, x1 * 0.7, H - 0.01, z1 * 0.7);
    pos.push(x0, 0, z0, x1 * 0.7, H - 0.01, z1 * 0.7, x0 * 0.7, H - 0.01, z0 * 0.7);
    for (let k = 0; k < 6; k++) sway.push(0);
  }
  return finalize(pos, null, sway);
}

/** Gorgone : un éventail ajouré, souple, orienté face au courant. */
export function makeSeaFan(seed = 67) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];
  const H = 0.20;

  function branch(x, y, ang, len, w, depth) {
    const ex = x + Math.sin(ang) * len;
    const ey = y + Math.cos(ang) * len;
    const nx = Math.cos(ang) * w, ny = -Math.sin(ang) * w;
    const s0 = y / H, s1 = ey / H;
    pos.push(
      x - nx, y - ny, 0, x + nx, y + ny, 0, ex + nx * 0.7, ey + ny * 0.7, 0,
      x - nx, y - ny, 0, ex + nx * 0.7, ey + ny * 0.7, 0, ex - nx * 0.7, ey - ny * 0.7, 0
    );
    sway.push(s0, s0, s1, s0, s1, s1);
    if (depth <= 0) return;
    const spread = 0.34 + rnd() * 0.18;
    branch(ex, ey, ang - spread, len * 0.74, w * 0.7, depth - 1);
    branch(ex, ey, ang + spread, len * 0.74, w * 0.7, depth - 1);
  }
  branch(0, 0, 0, 0.065, 0.005, 3);
  return finalize(pos, null, sway);
}

/** Rocher immergé : icosaèdre bruité, plus anguleux qu'un galet de plage. */
export function makeSeaRock(seed = 71) {
  const g = new THREE.IcosahedronGeometry(0.11, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.7 + 0.55 * Math.abs(Math.sin(x * 37) * Math.cos(z * 29) * Math.sin(y * 23));
    p.setXYZ(i, x * n * 1.15, y * n * 0.75, z * n * 1.05);
  }
  g.computeVertexNormals();
  g.translate(0, 0.03, 0);
  g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(p.count), 1));
  return g;
}

/** Oursin : une petite sphère hérissée de piquants. */
export function makeUrchin(seed = 83) {
  const rnd = mulberry(seed);
  const pos = [], sway = [];
  const body = new THREE.IcosahedronGeometry(0.028, 0);
  const bp = body.attributes.position;
  for (let i = 0; i < bp.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      pos.push(bp.getX(i + k), bp.getY(i + k) * 0.75 + 0.026, bp.getZ(i + k));
      sway.push(0);
    }
  }
  body.dispose();
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const e = rnd() * Math.PI * 0.45;
    const dx = Math.cos(a) * Math.cos(e), dy = Math.sin(e) + 0.25, dz = Math.sin(a) * Math.cos(e);
    const l = Math.hypot(dx, dy, dz);
    const len = 0.032 + rnd() * 0.022;
    const ex = (dx / l) * len, ey = 0.026 + (dy / l) * len, ez = (dz / l) * len;
    const w = 0.0022;
    pos.push(-w, 0.026, 0, w, 0.026, 0, ex, ey, ez);
    pos.push(0, 0.026, -w, 0, 0.026, w, ex, ey, ez);
    for (let k = 0; k < 6; k++) sway.push(0);
  }
  return finalize(pos, null, sway);
}
