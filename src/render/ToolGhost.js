/**
 * Apercus filaires des outils de sculpture : contour d'une ouverture avant
 * de percer, marches d'un escalier pendant le trace, trait de la regle, axe
 * du miroir. Un seul LineSegments a tampon dynamique, dessine par-dessus
 * tout (pas de test de profondeur) : un guide doit rester lisible a travers
 * le mur qu'on s'apprete a percer.
 */

import * as THREE from 'three';

const MAX_SEGMENTS = 6000;
/** Les traits sont poses un demi-centimetre au-dessus de la surface visee. */
const LIFT = 0.005;

export class ToolGhost {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.pos = new Float32Array(MAX_SEGMENTS * 6);
    this.col = new Float32Array(MAX_SEGMENTS * 6);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.renderOrder = 30;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.name = 'toolGhost';
    scene.add(this.lines);
    this._color = new THREE.Color();
  }

  /**
   * @param {Array<{lines: Array<Array<{x:number,y:number,z:number}>>, color?: string}>|null} specs
   */
  set(specs) {
    let n = 0;
    if (specs) {
      for (const spec of specs) {
        if (!spec || !spec.lines) continue;
        this._color.set(spec.color || '#ffffff');
        const r = this._color.r, g = this._color.g, b = this._color.b;
        for (const poly of spec.lines) {
          for (let k = 0; k + 1 < poly.length && n < MAX_SEGMENTS; k++) {
            const a = poly[k], c = poly[k + 1];
            const o = n * 6;
            this.pos[o] = a.x; this.pos[o + 1] = a.y + LIFT; this.pos[o + 2] = a.z;
            this.pos[o + 3] = c.x; this.pos[o + 4] = c.y + LIFT; this.pos[o + 5] = c.z;
            this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b;
            this.col[o + 3] = r; this.col[o + 4] = g; this.col[o + 5] = b;
            n++;
          }
        }
      }
    }
    this.lines.geometry.setDrawRange(0, n * 2);
    if (n > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
    this.lines.visible = n > 0;
  }

  hide() { this.set(null); }

  dispose() {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
