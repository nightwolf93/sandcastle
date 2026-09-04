/**
 * Rendu du terrain voxel : un THREE.Mesh par chunk, reconstruit a la volee
 * quand le mesher renvoie une nouvelle geometrie.
 *
 * On recycle les BufferGeometry : `setAttribute` avec un nouvel array est
 * gratuit cote CPU et ne provoque qu'un seul upload GPU par chunk modifie.
 */

import * as THREE from 'three';
import {
  CHUNK, CX, CY, CZ, CHUNK_COUNT, VOXEL,
  ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
} from '../core/Config.js';

export class TerrainRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Material} material
   */
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.scene.add(this.group);

    /** @type {(THREE.Mesh|null)[]} */
    this.meshes = new Array(CHUNK_COUNT).fill(null);
    this.triangles = 0;
  }

  /** Applique une geometrie fraiche (ou null pour vider le chunk). */
  update(ci, geo) {
    let mesh = this.meshes[ci];

    if (!geo) {
      if (mesh) {
        this.triangles -= mesh.geometry.index ? mesh.geometry.drawRange.count / 3 : 0;
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes[ci] = null;
      }
      return;
    }

    if (!mesh) {
      const g = new THREE.BufferGeometry();
      mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = 'chunk' + ci;
      mesh.userData.ci = ci;
      this.group.add(mesh);
      this.meshes[ci] = mesh;
    } else if (mesh.geometry.index) {
      this.triangles -= mesh.geometry.drawRange.count / 3;
    }

    // Les tampons GPU sont REMPLIS, pas recrees, tant qu'ils sont assez
    // grands (et pas plus de deux fois trop grands). Un chunk remaille dix
    // fois par seconde pendant qu'on verse du sable laissait derriere lui
    // quarante tampons orphelins par seconde, liberes seulement au passage du
    // ramasse-miettes : la memoire GPU et les pauses de collecte grimpaient
    // au fil de la partie. Le nombre de sommets reellement utilises est
    // porte par la plage de dessin, les sommets au-dela ne sont jamais
    // references par l'index.
    const g = mesh.geometry;
    fillAttribute(g, 'position', geo.positions, 3, false);
    fillAttribute(g, 'normal', geo.normals, 3, false);
    fillAttribute(g, 'aData', geo.attrs, 4, true);
    fillIndex(g, geo.indices);
    g.setDrawRange(0, geo.indexCount);

    // Bounding sphere calculee a la main : c'est le chunk, on la connait.
    const cy = (ci / (CX * CZ)) | 0;
    const rem = ci - cy * CX * CZ;
    const cz = (rem / CX) | 0;
    const cx = rem - cz * CX;
    const s = CHUNK * VOXEL;
    const center = new THREE.Vector3(
      ORIGIN_X + (cx + 0.5) * s,
      ORIGIN_Y + (cy + 0.5) * s,
      ORIGIN_Z + (cz + 0.5) * s
    );
    g.boundingSphere = new THREE.Sphere(center, s * 0.87);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(center.x - s / 2, center.y - s / 2, center.z - s / 2),
      new THREE.Vector3(center.x + s / 2, center.y + s / 2, center.z + s / 2)
    );

    this.triangles += geo.indexCount / 3;
  }

  dispose() {
    for (const m of this.meshes) {
      if (m) { this.group.remove(m); m.geometry.dispose(); }
    }
    this.meshes.fill(null);
    this.scene.remove(this.group);
  }
}

/** Un tampon existant est reutilisable s'il a le bon type et une taille proche. */
function reusable(attr, data) {
  if (!attr) return false;
  const a = attr.array;
  return a.constructor === data.constructor && a.length >= data.length && a.length <= data.length * 2 + 4096;
}

function fillAttribute(g, name, data, itemSize, normalized) {
  const attr = g.getAttribute(name);
  if (reusable(attr, data)) {
    attr.array.set(data);
    attr.needsUpdate = true;
    return;
  }
  g.setAttribute(name, new THREE.BufferAttribute(data, itemSize, normalized));
}

function fillIndex(g, indices) {
  const idx = g.index;
  if (reusable(idx, indices)) {
    idx.array.set(indices);
    idx.needsUpdate = true;
    return;
  }
  g.setIndex(new THREE.BufferAttribute(indices, 1));
}
