/**
 * Controles camera "diorama".
 *
 * Orbite amortie autour d'une cible posee sur la plage.
 *
 * Les DEUX boutons de souris sont reserves aux outils (clic gauche = action
 * principale, clic droit = action inverse), donc la camera vit sur :
 *   - clic molette          : orbite
 *   - Maj + clic molette    : translation (Maj peut etre presse ou relache
 *                             EN COURS de glissement : le mode suit)
 *   - Alt + clic gauche     : orbite    (pour les souris sans molette cliquable)
 *   - Alt + Maj + clic gauche : translation
 *   - molette               : zoom, ANCRE SUR LE CURSEUR
 *   - Ctrl + molette        : rayon de la brosse
 *   - Q / E                 : rotation, W A S D : deplacement
 *
 * La translation est une SAISIE DU SOL : le point du monde attrape sous le
 * curseur y reste pendant tout le glissement, quels que soient l'inclinaison
 * et le zoom. L'ancienne version translatait la cible d'un pas fixe par pixel
 * dans le plan horizontal : en vue rasante ou de loin, le monde ne suivait
 * plus la souris et le geste paraissait inverse ou incoherent. Le calcul se
 * fait sur la pose CIBLE de la camera (celle vers laquelle l'amortissement
 * tend), pas sur la pose affichee : sinon le retard de l'amortissement est
 * compte deux fois et la cible file toute seule.
 *
 * Le champ de vision est etroit (~32 deg) : c'est ce qui donne la lecture
 * "maquette" de la reference.
 */

import * as THREE from 'three';
import { WORLD_W, WORLD_D, clamp } from '../core/Config.js';

const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI * 0.49;

export class DioramaControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} dom
   */
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;

    this.target = new THREE.Vector3(0, 1.3, 0);
    this.goalTarget = this.target.clone();

    this.distance = 16.5;
    this.goalDistance = 16.5;
    this.minDistance = 1.4;
    this.maxDistance = Math.max(34, 2.7 * Math.max(WORLD_W, WORLD_D));

    this.azimuth = Math.PI * 0.78;
    this.goalAzimuth = this.azimuth;
    this.polar = 0.78; // ~45 deg depuis la verticale
    this.goalPolar = this.polar;

    this.damping = 0.16;
    this.enabled = true;
    this.autoRotate = false;
    this.autoRotateSpeed = 0.02;

    this._dragging = null; // 'orbit' | 'pan'
    this._dragButton = -1;
    this._last = new THREE.Vector2();
    this._pointerDownAt = 0;
    /** Point du sol attrape au debut d'une translation, et son plan. */
    this._panAnchor = new THREE.Vector3();
    this._panPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._panHit = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    /** Camera virtuelle a la pose cible, pour la saisie du sol. */
    this._goalCam = camera.clone();

    /**
     * Renvoie le point du monde sous un curseur, en coordonnees normalisees.
     * Fourni par le jeu (lancer de rayon dans le champ de voxels). Sert de
     * point d'ancrage au zoom.
     * @type {(ndcX:number, ndcY:number) => {x:number,y:number,z:number}|null}
     */
    this.resolveAnchor = null;
    this._anchor = new THREE.Vector3();

    this._onContext = (e) => e.preventDefault();
    this._onDown = (e) => this.onPointerDown(e);
    this._onMove = (e) => this.onPointerMove(e);
    this._onUp = (e) => this.onPointerUp(e);
    this._onWheel = (e) => this.onWheel(e);
    // Le clic molette declenche le defilement automatique de Windows : un
    // curseur a fleches qui fait derouler la page pendant qu'on orbite. Il
    // faut l'interdire sur mousedown ET auxclick, pointerdown ne suffit pas.
    this._onMiddle = (e) => { if (e.button === 1) e.preventDefault(); };

    dom.addEventListener('contextmenu', this._onContext);
    dom.addEventListener('mousedown', this._onMiddle);
    dom.addEventListener('auxclick', this._onMiddle);
    dom.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });

    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    this.update(0);
  }

  onPointerDown(e) {
    if (!this.enabled) return;
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this._dragButton = e.button;
      this.setDragMode(e.shiftKey ? 'pan' : 'orbit', e);
    } else {
      return;
    }
    e.preventDefault();
    this._last.set(e.clientX, e.clientY);
    this.dom.setPointerCapture?.(e.pointerId);
  }

  /** Orbite ou translation ; une translation attrape le sol sous le curseur. */
  setDragMode(mode, e) {
    if (mode === this._dragging) return;
    this._dragging = mode;
    if (mode === 'pan') this.beginPan(e);
  }

  onPointerMove(e) {
    if (!this._dragging) return;
    // Maj presse ou relache en cours de route : on change de mode sans
    // relacher le bouton. C'est ce qu'attend une main qui hesite.
    this.setDragMode(e.shiftKey ? 'pan' : 'orbit', e);
    const dx = e.clientX - this._last.x;
    const dy = e.clientY - this._last.y;
    this._last.set(e.clientX, e.clientY);

    if (this._dragging === 'orbit') {
      this.goalAzimuth -= dx * 0.0055;
      this.goalPolar = clamp(this.goalPolar - dy * 0.0045, MIN_POLAR, MAX_POLAR);
    } else {
      this.pan(e);
    }
  }

  onPointerUp(e) {
    if (this._dragging) {
      this.dom.releasePointerCapture?.(e.pointerId);
      this._dragging = null;
      this._dragButton = -1;
    }
  }

  onWheel(e) {
    if (!this.enabled) return;
    // Ctrl + molette appartient a l'outil (rayon de brosse) ; la molette nue
    // zoome, comme tout le monde s'y attend.
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();

    // Normalisation : selon le peripherique et le navigateur, deltaY arrive en
    // pixels, en lignes ou en pages. Sans ca, un pas de molette fait un
    // vingtieme de zoom sur une machine et un bond sur une autre.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;        // lignes
    else if (e.deltaMode === 2) dy *= 400;  // pages
    // Un trackpad envoie beaucoup de petits evenements : on borne le pas.
    dy = clamp(dy, -240, 240);

    const wanted = this.goalDistance * Math.exp(dy * 0.0016);
    const next = clamp(wanted, this.minDistance, this.maxDistance);
    this.zoomTowardCursor(e, next);
  }

  /**
   * Zoom ancre sur le curseur.
   *
   * On veut que le point du monde survole reste exactement sous le curseur.
   * En notant A ce point d'ancrage, T la cible de l'orbite et k le rapport de
   * zoom, il suffit de poser :
   *
   *     T' = A + k (T - A)      et      d' = k d
   *
   * La position de camera devient alors P' = A + k (P - A) : la camera se
   * deplace sur la droite qui la relie a A, sans changer d'orientation. La
   * direction camera -> A est donc identique a un facteur d'echelle pres, et A
   * se projette au meme pixel. C'est exact, pas approche.
   *
   * Deplacer uniquement la distance zoomerait vers le centre de l'ecran ;
   * deplacer la cible sans ce couplage ferait deriver la camera. C'est le
   * couplage des deux qui donne le bon comportement.
   */
  zoomTowardCursor(e, newDistance) {
    const prev = this.goalDistance;
    if (prev <= 0) return;
    const k = newDistance / prev;
    this.goalDistance = newDistance;
    if (Math.abs(k - 1) < 1e-5) return;

    let anchor = null;
    if (this.resolveAnchor) {
      const r = this.dom.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
      anchor = this.resolveAnchor(nx, ny);
    }
    // Rien sous le curseur (le ciel) : on garde le comportement classique,
    // centre sur la cible.
    if (!anchor) return;

    this._anchor.set(anchor.x, anchor.y, anchor.z);
    const t = this.goalTarget;
    t.set(
      this._anchor.x + (t.x - this._anchor.x) * k,
      this._anchor.y + (t.y - this._anchor.y) * k,
      this._anchor.z + (t.z - this._anchor.z) * k
    );
    this.clampTarget();
  }

  /**
   * Pose CIBLE de la camera (celle vers laquelle l'amortissement tend), dans
   * une camera virtuelle : c'est elle qui sert a la saisie du sol.
   */
  goalCamera() {
    const c = this._goalCam;
    c.fov = this.camera.fov;
    c.aspect = this.camera.aspect;
    c.near = this.camera.near;
    c.far = this.camera.far;
    c.updateProjectionMatrix();
    const sp = Math.sin(this.goalPolar);
    c.position.set(
      this.goalTarget.x + this.goalDistance * sp * Math.sin(this.goalAzimuth),
      this.goalTarget.y + this.goalDistance * Math.cos(this.goalPolar),
      this.goalTarget.z + this.goalDistance * sp * Math.cos(this.goalAzimuth)
    );
    c.lookAt(this.goalTarget);
    c.updateMatrixWorld(true);
    return c;
  }

  /** Point du plan de saisie (y = hauteur de la cible) sous le curseur. */
  groundUnderCursor(e, out) {
    const r = this.dom.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this._ray.setFromCamera(this._ndc, this.goalCamera());
    return this._ray.ray.intersectPlane(this._panPlane, out);
  }

  beginPan(e) {
    // Le plan de saisie est horizontal, a la hauteur de la cible : c'est le
    // sol que le joueur croit tenir. Si le sable est visible sous le curseur,
    // on prefere sa vraie hauteur, sinon la vue rasante attrape un plan qui
    // n'est pas celui qu'on regarde.
    let y = this.goalTarget.y;
    if (this.resolveAnchor) {
      const r = this.dom.getBoundingClientRect();
      const hit = this.resolveAnchor(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      );
      if (hit) y = hit.y;
    }
    this._panPlane.constant = -y;
    if (!this.groundUnderCursor(e, this._panAnchor)) {
      this._panAnchor.copy(this.goalTarget);
    }
  }

  pan(e) {
    // Le point attrape doit rester sous le curseur : on deplace la cible de
    // l'ecart entre lui et ce qui se trouve maintenant sous le curseur.
    if (!this.groundUnderCursor(e, this._panHit)) return;
    const dx = this._panAnchor.x - this._panHit.x;
    const dz = this._panAnchor.z - this._panHit.z;
    // Garde-fou : un rayon presque parallele au sol donne des intersections
    // a des dizaines de metres. On borne le pas a la largeur du domaine.
    const lim = WORLD_W;
    this.goalTarget.x += clamp(dx, -lim, lim);
    this.goalTarget.z += clamp(dz, -lim, lim);
    this.clampTarget();
  }

  clampTarget() {
    const m = 1.2;
    this.goalTarget.x = clamp(this.goalTarget.x, -WORLD_W / 2 - m, WORLD_W / 2 + m);
    this.goalTarget.z = clamp(this.goalTarget.z, -WORLD_D / 2 - m, WORLD_D / 2 + m);
    this.goalTarget.y = clamp(this.goalTarget.y, 0.2, 3.2);
  }

  /** Recentre doucement sur un point du monde. */
  focus(x, y, z, distance) {
    this.goalTarget.set(x, y, z);
    if (distance) this.goalDistance = clamp(distance, this.minDistance, this.maxDistance);
    this.clampTarget();
  }

  update(dt) {
    // Clavier
    if (this.enabled && this.keys.size) {
      const sp = 3.2 * dt * (this.keys.has('ShiftLeft') ? 2.4 : 1);
      const fwd = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
      const right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
      if (this.keys.has('KeyW')) this.goalTarget.addScaledVector(fwd, sp);
      if (this.keys.has('KeyS')) this.goalTarget.addScaledVector(fwd, -sp);
      if (this.keys.has('KeyA')) this.goalTarget.addScaledVector(right, -sp);
      if (this.keys.has('KeyD')) this.goalTarget.addScaledVector(right, sp);
      if (this.keys.has('KeyQ')) this.goalAzimuth += 1.4 * dt;
      if (this.keys.has('KeyE')) this.goalAzimuth -= 1.4 * dt;
      this.clampTarget();
    }

    if (this.autoRotate && !this._dragging) {
      this.goalAzimuth += this.autoRotateSpeed * dt;
    }

    const k = dt > 0 ? 1 - Math.pow(1 - this.damping, dt * 60) : 1;
    this.azimuth += (this.goalAzimuth - this.azimuth) * k;
    this.polar += (this.goalPolar - this.polar) * k;
    this.distance += (this.goalDistance - this.distance) * k;
    this.target.lerp(this.goalTarget, k);

    const sp = Math.sin(this.polar);
    const x = this.target.x + this.distance * sp * Math.sin(this.azimuth);
    const y = this.target.y + this.distance * Math.cos(this.polar);
    const z = this.target.z + this.distance * sp * Math.cos(this.azimuth);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  dispose() {
    this.dom.removeEventListener('contextmenu', this._onContext);
    this.dom.removeEventListener('mousedown', this._onMiddle);
    this.dom.removeEventListener('auxclick', this._onMiddle);
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('wheel', this._onWheel);
  }
}
