/**
 * Previsualisation et lissage de l'outil de construction en sable.
 *
 * La geometrie jaune est volontairement independante du terrain voxel : elle
 * repond instantanement pendant le trace, puis Brush.js ecrit le meme volume
 * dans le champ au relachement de la souris.
 */

import * as THREE from 'three';
import { clamp, VOXEL } from '../core/Config.js';
import { mergeGeoms } from '../render/GeoUtils.js';

/**
 * Transforme les points bruts du geste en spline echantillonnee regulierement.
 * Les deux extremites sont conservees exactement pour que le mur commence et
 * finisse sous la souris.
 */
export function smoothSandPath(points, smoothness = 0.55, spacing = VOXEL * 0.8) {
  if (!points?.length) return [];
  if (points.length === 1) return [{ ...points[0] }];

  const src = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  let estimated = 0;
  for (let i = 1; i < src.length; i++) estimated += src[i].distanceTo(src[i - 1]);
  const divisions = clamp(Math.ceil(estimated / Math.max(VOXEL * 0.45, spacing)), 2, 512) | 0;

  let sampled;
  if (src.length === 2 || smoothness <= 0.01) {
    // Reechantillonnage de la POLYLIGNE (et pas seulement de la droite entre
    // ses extremites) : a lissage nul, tous les angles dessines sont gardes.
    sampled = [src[0].clone()];
    let seg = 1, walked = 0;
    for (let k = 1; k < divisions; k++) {
      const wanted = estimated * k / divisions;
      while (seg < src.length) {
        const len = src[seg].distanceTo(src[seg - 1]);
        if (walked + len >= wanted || seg === src.length - 1) {
          const t = len > 1e-6 ? clamp((wanted - walked) / len, 0, 1) : 0;
          sampled.push(src[seg - 1].clone().lerp(src[seg], t));
          break;
        }
        walked += len;
        seg++;
      }
    }
    sampled.push(src[src.length - 1].clone());
  } else {
    const curve = new THREE.CatmullRomCurve3(src, false, 'catmullrom', 0.08 + smoothness * 0.72);
    sampled = curve.getSpacedPoints(divisions);
  }

  sampled[0].copy(src[0]);
  sampled[sampled.length - 1].copy(src[src.length - 1]);
  return sampled.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

/** Longueur XZ d'un chemin monde. */
export function sandPathLength(points) {
  let out = 0;
  for (let i = 1; i < points.length; i++) {
    out += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return out;
}

/** Point et tangente a une distance donnee le long du chemin. */
function pathAt(points, wanted) {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + len >= wanted || i === points.length - 1) {
      const t = len > 1e-6 ? clamp((wanted - walked) / len, 0, 1) : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
      };
    }
    walked += len;
  }
  const p = points[points.length - 1];
  return { ...p, yaw: 0 };
}

export class SandBuilderPreview {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'sandBuilderPreview';
    this.root.renderOrder = 18;

    this.fillMaterial = new THREE.MeshBasicMaterial({
      color: 0xf2b45f,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0xfff1bd,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMaterial);
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMaterial);
    this.mesh.renderOrder = 18;
    this.lines.renderOrder = 19;
    this.root.add(this.mesh, this.lines);
    this.root.visible = false;
    scene.add(this.root);
    this._signature = '';
  }

  hide() {
    this.root.visible = false;
    this._signature = '';
  }

  /**
   * @param {object} tool reglages de l'outil sable
   * @param {{x:number,y:number,z:number}|null} hit point vise
   * @param {Array<{x:number,y:number,z:number}>} rawPath trace en cours
   */
  update(tool, hit, rawPath = []) {
    if (!tool || !hit) { this.hide(); return; }
    const sig = [
      tool.mode, tool.blockWidth, tool.blockLength, tool.height, tool.rotation,
      tool.wallWidth, tool.wallHeight, tool.smoothness, tool.crenels,
      tool.crenelWidth, tool.crenelHeight,
      tool.towerRadius, tool.towerHeight, tool.towerTaper, tool.roof, tool.roofHeight,
      tool.domeRadius, tool.domeHeight,
      hit.x.toFixed(3), hit.y.toFixed(3), hit.z.toFixed(3),
      ...rawPath.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`),
    ].join('|');
    if (sig === this._signature) { this.root.visible = true; return; }
    this._signature = sig;

    if (tool.mode === 'tower' || tool.mode === 'dome') {
      this.replaceGeometry(makeRevolutionGeometry(tool, hit));
      this.root.visible = true;
      return;
    }
    const boxes = [];
    if (tool.mode === 'block') {
      boxes.push({
        x: hit.x, y: hit.y + tool.height * 0.5, z: hit.z,
        width: tool.blockWidth, height: tool.height, length: tool.blockLength,
        yaw: tool.rotation,
      });
    } else {
      let path;
      if (rawPath.length >= 2) {
        path = smoothSandPath(rawPath, tool.smoothness);
      } else {
        // Avant le premier clic, un troncon temoin montre l'epaisseur et la
        // hauteur choisies sans pretendre qu'il sera deja pose.
        const yaw = tool.rotation || 0;
        const half = Math.max(0.28, tool.wallWidth * 1.5);
        path = [
          { x: hit.x - Math.sin(yaw) * half, y: hit.y, z: hit.z - Math.cos(yaw) * half },
          { x: hit.x + Math.sin(yaw) * half, y: hit.y, z: hit.z + Math.cos(yaw) * half },
        ];
      }
      this.addWallBoxes(boxes, path, tool);
    }

    this.replaceGeometry(makeBoxesGeometry(boxes));
    this.root.visible = boxes.length > 0;
  }

  addWallBoxes(boxes, path, tool) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-4) continue;
      boxes.push({
        x: (a.x + b.x) * 0.5,
        y: (a.y + b.y) * 0.5 + tool.wallHeight * 0.5,
        z: (a.z + b.z) * 0.5,
        width: tool.wallWidth,
        height: tool.wallHeight,
        length: len + Math.min(tool.wallWidth * 0.35, 0.04),
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
      });
    }
    if (!tool.crenels) return;
    const length = sandPathLength(path);
    const step = Math.max(VOXEL * 3, tool.crenelWidth * 2);
    for (let d = 0; d <= length + 1e-5; d += step) {
      const p = pathAt(path, d);
      boxes.push({
        x: p.x,
        y: p.y + tool.wallHeight + tool.crenelHeight * 0.5,
        z: p.z,
        width: tool.wallWidth,
        height: tool.crenelHeight,
        length: tool.crenelWidth,
        yaw: p.yaw,
      });
    }
  }

  replaceGeometry(geometry) {
    const oldMesh = this.mesh.geometry;
    const oldLines = this.lines.geometry;
    this.mesh.geometry = geometry;
    this.lines.geometry = new THREE.EdgesGeometry(geometry, 28);
    oldMesh.dispose();
    oldLines.dispose();
  }

  dispose() {
    this.scene.remove(this.root);
    this.mesh.geometry.dispose();
    this.lines.geometry.dispose();
    this.fillMaterial.dispose();
    this.lineMaterial.dispose();
  }
}

/** Construit un BufferGeometry partage par tous les parallelepipedes. */
/** Apercu d'une tour (cylindre, toit conique) ou d'un dome, pose en `hit`. */
function makeRevolutionGeometry(tool, hit) {
  const parts = [];
  if (tool.mode === 'tower') {
    const rTop = tool.towerRadius * (1 - tool.towerTaper);
    const body = new THREE.CylinderGeometry(rTop, tool.towerRadius, tool.towerHeight, 28, 1, false);
    body.translate(hit.x, hit.y + tool.towerHeight * 0.5, hit.z);
    parts.push(body);
    if (tool.roof) {
      const roof = new THREE.ConeGeometry(rTop * 1.08, tool.roofHeight, 28, 1, false);
      roof.translate(hit.x, hit.y + tool.towerHeight + tool.roofHeight * 0.5, hit.z);
      parts.push(roof);
    }
  } else {
    const dome = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
    dome.scale(tool.domeRadius, tool.domeHeight, tool.domeRadius);
    dome.translate(hit.x, hit.y, hit.z);
    parts.push(dome);
  }
  const g = mergeGeoms(parts);
  g.computeBoundingSphere();
  return g;
}

function makeBoxesGeometry(boxes) {
  const positions = [];
  const indices = [];
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const faces = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    3, 7, 6, 3, 6, 2, 0, 1, 5, 0, 5, 4,
  ];
  for (const box of boxes) {
    const base = positions.length / 3;
    const hx = box.width * 0.5, hy = box.height * 0.5, hz = box.length * 0.5;
    const cs = Math.cos(box.yaw || 0), sn = Math.sin(box.yaw || 0);
    for (const c of corners) {
      const lx = c[0] * hx, lz = c[2] * hz;
      positions.push(
        box.x + lx * cs + lz * sn,
        box.y + c[1] * hy,
        box.z - lx * sn + lz * cs
      );
    }
    for (const i of faces) indices.push(base + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
