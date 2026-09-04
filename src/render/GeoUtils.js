/**
 * Helpers de geometrie procedurale partages par Props.js et ToolGeometry.js.
 *
 * `mergeGeoms` et `mulberry` vivaient en double (Props.js / SeaLifeGeometry.js).
 * Ils sont ici une bonne fois pour toutes : aucun outil, aucun prop ne doit
 * reecrire une fusion de BufferGeometry.
 */

import * as THREE from 'three';

/** Fusion simple de BufferGeometry indexees ou non. Sortie non indexee. */
export function mergeGeoms(list) {
  let total = 0;
  for (const g of list) total += g.index ? g.index.count : g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.normal;
    const idx = g.index;
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i++) {
      const j = idx ? idx.getX(i) : i;
      pos[o * 3] = p.getX(j); pos[o * 3 + 1] = p.getY(j); pos[o * 3 + 2] = p.getZ(j);
      nrm[o * 3] = n.getX(j); nrm[o * 3 + 1] = n.getY(j); nrm[o * 3 + 2] = n.getZ(j);
      o++;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/** PRNG deterministe : la meme touffe, le meme seau, a chaque lancement. */
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
 * Anse / arceau : un tube de section carree suivant un arc de cercle, dans le
 * plan XY.
 *
 * Moins cher qu'un TorusGeometry (4 faces par segment au lieu de 8) et la
 * section carree accroche mieux la lumiere a petite taille : a 18 px, ce sont
 * les aretes qui dessinent l'objet, pas les degrades.
 *
 * @param {number} R      rayon de l'arc
 * @param {number} th     demi-epaisseur du tube
 * @param {number} a0     angle de debut (rad)
 * @param {number} a1     angle de fin (rad)
 * @param {number} seg    nombre de segments le long de l'arc
 */
export function makeArc(R, th, a0, a1, seg = 12) {
  const pos = [];
  const quad = (p0, p1, p2, p3) => pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  let prev = null;
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (a1 - a0) * (i / seg);
    const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
    const nx = Math.cos(a), ny = Math.sin(a);
    const ring = [
      [cx + nx * th, cy + ny * th, +th],
      [cx + nx * th, cy + ny * th, -th],
      [cx - nx * th, cy - ny * th, -th],
      [cx - nx * th, cy - ny * th, +th],
    ];
    if (prev) {
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        quad(prev[k], ring[k], ring[k2], prev[k2]);
      }
    }
    prev = ring;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/** Nombre de triangles d'une geometrie — sert au controle de budget. */
export function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
