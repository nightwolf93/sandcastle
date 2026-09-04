/**
 * Les outils que le joueur a laisses sur la plage.
 *
 * Un outil qui disparait quand on change d'outil est un item d'inventaire. Un
 * outil qui reste plante la ou on l'a laisse est un OBJET : il porte une
 * ombre, il suit le terrain (si on creuse dessous, il tombe), la maree peut
 * l'emporter, et un clic le ramasse. Une plage avec une pelle plantee pres du
 * trou d'eau, un rateau au bord de l'allee ratissee et un seau retourne au
 * pied de la tour, c'est un CHANTIER — de la narration environnementale
 * gratuite.
 *
 * Le mecanisme de suivi de terrain est celui de `Props.update()`, avec deux
 * differences : les outils sont peu nombreux et tous differents (donc des
 * `Mesh` simples, pas d'`InstancedMesh`), et ils se desensablent quatre fois
 * plus lentement que les coquillages — ce qui les laisse plusieurs secondes a
 * moitie enterres, manche depassant du sable.
 *
 * Plafond volontairement bas (12) : au-dela, la plage devient un debarras et
 * le chantier ne se lit plus. Le plus ancien s'enfonce et disparait.
 */

import * as THREE from 'three';
import { clamp } from '../core/Config.js';

export const MAX_DROPPED = 12;

/** Rayon de tolerance du ramassage, en pixels d'ecran. */
const PICK_PIXELS = 18;

export class DroppedTools {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {(id:string, state:object)=>THREE.Object3D} makeMesh fabrique fournie par ToolAvatar
   */
  constructor(game, makeMesh) {
    this.game = game;
    this.makeMesh = makeMesh;
    this.group = new THREE.Group();
    this.group.name = 'droppedTools';
    game.scene.add(this.group);
    this.items = [];
    this._retiring = [];
    this._cursor = 0;
    this._ray = new THREE.Raycaster();
    this._p = new THREE.Vector3();
    this.hovered = null;
  }

  get count() { return this.items.length; }

  /**
   * @param {string} id
   * @param {THREE.Vector3} p
   * @param {THREE.Quaternion} q
   * @param {number} scale
   * @param {object} state  { depth, fill, moisture… } — l'etat visible est conserve
   */
  add(id, p, q, scale, state = {}) {
    if (this.items.length >= MAX_DROPPED) this._retireOldest();
    const obj = this.makeMesh(id, state);
    if (!obj) return null;
    obj.position.copy(p);
    obj.quaternion.copy(q);
    obj.scale.setScalar(scale);
    obj.traverse((m) => {
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    obj.userData.toolId = id;
    this.group.add(obj);
    const item = {
      id, obj, state,
      scale,
      born: this.game.time,
      // Ecart entre l'origine du mesh et la surface au moment de la pose. Le
      // suivi de terrain le conserve : une pelle plantee reste enfoncee de la
      // meme hauteur quand le sable monte ou descend sous elle.
      yOff: p.y - this.game.field.surfaceHeightAt(p.x, p.z),
      drift: 0,
      warned: false,
    };
    this.items.push(item);
    return item;
  }

  /** Le plus ancien s'enfonce sur 1,2 s puis disparait. Jamais de « pop ». */
  _retireOldest() {
    const it = this.items.shift();
    if (!it) return;
    if (this.hovered === it) this.hovered = null;
    it.retiring = 0;
    this._retiring.push(it);
  }

  /**
   * Ramassage : renvoie l'item sous le pointeur, ou null.
   *
   * Ne teste QUE le groupe des outils — jamais la scene entiere, sinon on
   * paierait un raycast sur tout le terrain a chaque mouvement de souris.
   *
   * Deux passes, et la seconde n'est pas un luxe : le manche d'une pelle
   * plantee fait 2 cm de large, soit DEUX PIXELS a la distance de travail.
   * Exiger que le rayon tombe pile dessus, c'est rendre le ramassage
   * injouable — et effectivement, un clic sur deux creusait un trou a cote au
   * lieu de reprendre l'outil. On tolere donc un rayon de 18 px autour de
   * l'axe de l'objet.
   */
  pick(pointer, camera) {
    if (!this.items.length) return null;
    this._ray.setFromCamera(pointer, camera);
    const hits = this._ray.intersectObjects(this.group.children, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.toolId) o = o.parent;
      if (o) {
        const it = this.items.find((i) => i.obj === o);
        if (it) return it;
      }
    }

    // Passe de tolerance : distance en pixels a l'axe de l'objet.
    const h = this.game.renderer?.domElement?.clientHeight || 800;
    const tol = (2 * PICK_PIXELS) / h;       // en unites NDC
    let best = null;
    let bestD = tol;
    for (const it of this.items) {
      if (!it.obj.visible) continue;
      for (let k = 0; k <= 2; k++) {
        this._p.set(0, k * 0.16, 0).applyQuaternion(it.obj.quaternion)
          .multiplyScalar(it.scale).add(it.obj.position);
        this._p.project(camera);
        if (this._p.z > 1) continue;         // derriere la camera
        const d = Math.hypot(this._p.x - pointer.x, this._p.y - pointer.y);
        if (d < bestD) { bestD = d; best = it; }
      }
    }
    return best;
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (this.hovered === item) this.hovered = null;
    this.group.remove(item.obj);
    item.obj.traverse((m) => { m.material?.dispose?.(); });
  }

  /** Surbrillance au survol : un lisere, pas de texte. Le clic est le geste
   *  par defaut, il n'y a rien a expliquer. */
  setHover(item) {
    if (this.hovered === item) return;
    const paint = (it, on) => it?.obj.traverse((m) => {
      if (m.material && m.material.emissive) m.material.emissiveIntensity = on ? 2.6 : 1.0;
    });
    paint(this.hovered, false);
    this.hovered = item;
    paint(item, true);
  }

  // -------------------------------------------------------------------------

  update(dt) {
    const F = this.game.field;
    const W = this.game.water;

    for (let i = this._retiring.length - 1; i >= 0; i--) {
      const it = this._retiring[i];
      it.retiring += dt;
      it.obj.position.y -= dt * 0.09;
      if (it.retiring > 1.2) {
        this.group.remove(it.obj);
        it.obj.traverse((m) => { m.material?.dispose?.(); });
        this._retiring.splice(i, 1);
      }
    }

    // Comme Props.update() : une tranche par frame. Avec 12 objets et une
    // tranche sur trois, chacun est verifie 20 fois par seconde — largement
    // assez pour qu'aucun outil ne reste suspendu en l'air.
    const stride = 3;
    for (let i = this._cursor % stride; i < this.items.length; i += stride) {
      const it = this.items[i];
      const p = it.obj.position;
      const surf = F.surfaceHeightAt(p.x, p.z);
      // La cible : la POINTE de l'outil au niveau du sable. L'enfoncement est
      // deja dans la pose, d'ou l'ecart memorise a la depose.
      const d = surf + it.yOff - p.y;
      if (d < -0.004) p.y += Math.max(d, -2.5 * dt);        // le sol a baisse
      else if (d > 0.02) p.y += Math.min(d, 0.25 * dt);     // ensablement lent

      // --- la maree ---------------------------------------------------------
      const depth = W ? W.depthAt(p.x, p.z) : 0;
      if (depth > 0.05) {
        // L'objet part vers l'aval : on suit le gradient de hauteur d'eau, le
        // seul champ dont on soit sur qu'il existe.
        const e = 0.12;
        const gx = W.depthAt(p.x + e, p.z) - W.depthAt(p.x - e, p.z);
        const gz = W.depthAt(p.x, p.z + e) - W.depthAt(p.x, p.z - e);
        const s = clamp(depth * 0.9, 0, 0.6);
        p.x += gx * s * dt * 3.0;
        p.z += gz * s * dt * 3.0;
        it.obj.rotateY(dt * s * 2.2);   // il roule un peu en derivant
        it.drift += dt;
        if (it.drift > 0.6 && !it.warned) {
          it.warned = true;
          this.game.toast('La mer emporte tes outils !');
        }
      } else it.drift = 0;

      // A plus de 12 cm sous la surface, l'outil est enterre. Il ressortira
      // quand la maree redescendra et erodera le sable.
      it.obj.visible = surf - p.y < 0.12;
    }
    this._cursor++;
  }

  serialize() {
    return this.items.map((it) => ({
      id: it.id,
      p: [+it.obj.position.x.toFixed(3), +it.obj.position.y.toFixed(3),
        +it.obj.position.z.toFixed(3)],
      q: [+it.obj.quaternion.x.toFixed(4), +it.obj.quaternion.y.toFixed(4),
        +it.obj.quaternion.z.toFixed(4), +it.obj.quaternion.w.toFixed(4)],
      s: +it.scale.toFixed(4),
      st: it.state,
    }));
  }

  deserialize(data) {
    for (const it of [...this.items]) this.remove(it);
    if (Array.isArray(data)) {
      for (const d of data) {
        this.add(d.id, new THREE.Vector3(...d.p), new THREE.Quaternion(...d.q),
          d.s, d.st || {});
      }
    }
    // Le monde vient d'etre remplace : l'etat « plante » de l'avatar doit
    // suivre ce qui est reellement au sol, sinon l'outil courant peut rester
    // invisible en main.
    this.game.toolAvatar?.syncStowed?.(new Set(this.items.map((i) => i.id)));
  }

  dispose() {
    for (const it of [...this.items]) this.remove(it);
    this.game.scene.remove(this.group);
  }
}
