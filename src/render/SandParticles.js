/**
 * Un seul systeme de particules pour tout le jeu : grains, poussiere, gouttes.
 *
 * Choix : `THREE.Points`, pool a taille fixe, simulation CPU en tableaux
 * types, un seul draw call.
 *
 * Pourquoi pas `InstancedMesh` ? A notre echelle, un grain de sable fait 1 a
 * 3 pixels. A cette taille, une rotation n'existe pas, une ombre n'existe pas,
 * une forme n'existe pas : payer 24 sommets par grain serait absurde.
 *
 * Pourquoi pas de particules GPU ? Le ping-pong de FBO devient rentable
 * au-dela de ~50 000 particules. A 3 000, la simulation CPU coute ~0,05 ms —
 * trois ordres de grandeur sous la passe granulaire — et elle peut lire
 * `field.surfaceHeightAt()`, ce qu'un shader ne pourrait pas faire.
 *
 * Style : meme esprit que `Props.js` — tout est preallouable, rien n'alloue en
 * jeu, et le systeme ne connait du jeu que `field.surfaceHeightAt()`.
 */

import * as THREE from 'three';

/**
 * Parametres par espece : [taille (m), gravite, vie (s), trainee].
 *
 * 0 grain sec     — rebondit une fois puis meurt
 * 1 grain humide  — colle immediatement
 * 2 poussiere     — enfle en vieillissant et s'evanouit
 * 3 goutte        — mouille vraiment le sable une fois sur huit
 * 4 eclaboussure  — meurt au contact
 * 5 embrun        — brume blanche projetee par le rouleau, freinee par l'air,
 *                   meurt au contact de l'eau ou du sable
 */
const KIND = [
  [0.0025, 1.00, 0.90, 0.02],
  [0.0040, 1.00, 0.70, 0.03],
  [0.0090, 0.25, 1.40, 0.55],
  [0.0030, 1.00, 1.10, 0.05],
  [0.0060, 0.90, 0.50, 0.10],
  [0.0110, 0.70, 0.90, 0.32],
];

export class SandParticles {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/VoxelField.js').VoxelField} field
   * @param {number} max
   */
  constructor(scene, field, max = 3000) {
    this.scene = scene;
    this.field = field;
    this.max = max;
    this.count = 0;            // particules vivantes, compactees en tete

    this.px = new Float32Array(max * 3);   // position (attribut GPU)
    this.vx = new Float32Array(max * 3);   // vitesse (CPU seul)
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.kind = new Float32Array(max);
    this.ground = new Float32Array(max);   // altitude du sol, echantillonnee
    this.seed = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.BufferAttribute(this.px, 3).setUsage(THREE.DynamicDrawUsage));
    // aData : x = espece, y = vie normalisee 1->0, z = graine, w = taille (m).
    // La taille voyage dans l'attribut plutot que dans un tableau constant du
    // shader : les tableaux initialises a la declaration n'existent pas en
    // GLSL ES 1.00, qui est ce que three.js compile par defaut.
    this.data = new Float32Array(max * 4);
    geo.setAttribute('aData',
      new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    // Sphere fixe : recalculer une borne sur 3 000 points 60 fois par seconde
    // couterait plus cher que toute la simulation.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 40);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // NORMAL et pas Additive : en plein soleil, une poussiere additive
      // ressemble a du feu. Le sable diffuse, il n'emet pas.
      blending: THREE.NormalBlending,
      uniforms: {
        // pixelScale = hauteur du viewport / (2 tan(fov/2)) :
        // gl_PointSize = taille_monde * pixelScale / distance donne une taille
        // perspective EXACTE, en pixels.
        uPixelScale: { value: 900 },
        uSun: { value: new THREE.Color(0xfff0d8) },
      },
      vertexShader: /* glsl */`
        attribute vec4 aData;
        varying vec4 vData;
        uniform float uPixelScale;
        void main() {
          vData = aData;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float sz = aData.w;
          // La poussiere ENFLE en vieillissant, les grains non.
          if (aData.x > 1.5 && aData.x < 2.5) sz *= 1.0 + 2.2 * (1.0 - aData.y);
          gl_PointSize = clamp(sz * uPixelScale / max(-mv.z, 0.05), 1.0, 24.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec4 vData;
        uniform vec3 uSun;
        void main() {
          // Point rond : on jette les coins du quad.
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float k = vData.x;
          float life = vData.y;
          vec3 col;
          float a = 1.0;
          if (k < 0.5)      { col = vec3(0.86, 0.78, 0.62); }
          else if (k < 1.5) { col = vec3(0.58, 0.48, 0.35); }
          else if (k < 2.5) { col = vec3(0.92, 0.89, 0.83); a = 0.35 * life * life; }
          else if (k < 3.5) { col = vec3(0.36, 0.62, 0.82); }
          else if (k < 4.5) { col = vec3(0.95, 0.97, 1.00); a = 0.70 * life; }
          else              { col = vec3(0.97, 0.99, 1.00); a = 0.55 * life * (0.6 + 0.4 * life); }
          // Un soupcon de relief : plus clair au centre.
          col *= (0.86 + 0.30 * (1.0 - r2 * 4.0)) * uSun;
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
    this.points.renderOrder = 3;
    scene.add(this.points);

    this._acc = 0;     // accumulateur pour les flux fractionnaires
    this._gsCursor = 0;
    /** Crochet optionnel : une goutte sur huit mouille vraiment le sable. */
    this._wet = null;
  }

  /** A appeler dans Game.resize() : c'est ce qui rend la taille exacte. */
  setViewport(heightPx, fovDeg) {
    this.material.uniforms.uPixelScale.value =
      heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  // --- emission ------------------------------------------------------------

  /** Une particule. Renvoie false si le pool est plein (on ne grossit jamais). */
  spawn(kind, x, y, z, vx, vy, vz) {
    if (this.count >= this.max) return false;
    const i = this.count++;
    const K = KIND[kind] || KIND[0];
    this.px[i * 3] = x; this.px[i * 3 + 1] = y; this.px[i * 3 + 2] = z;
    this.vx[i * 3] = vx; this.vx[i * 3 + 1] = vy; this.vx[i * 3 + 2] = vz;
    this.life[i] = this.life0[i] = K[2] * (0.7 + Math.random() * 0.6);
    this.kind[i] = kind;
    this.seed[i] = Math.random();
    // Echantillonnage du sol UNE FOIS. Le rafraichir chaque frame pour chaque
    // particule couterait plus cher que toute la simulation.
    this.ground[i] = this.field.surfaceHeightAt(x, z);
    return true;
  }

  /**
   * Bouffee dans un cone.
   * @param {{speed?:number, spread?:number, dir?:number[]}} o
   */
  burst(kind, x, y, z, n, o = {}) {
    const sp = o.speed ?? 1.2, spread = o.spread ?? 0.8;
    const d = o.dir ?? [0, 1, 0];
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const s = sp * (0.55 + Math.random() * 0.9);
      this.spawn(kind,
        x + (Math.random() - 0.5) * 0.02,
        y + Math.random() * 0.02,
        z + (Math.random() - 0.5) * 0.02,
        (d[0] + Math.cos(a) * r) * s,
        (d[1] + (Math.random() - 0.3) * r) * s,
        (d[2] + Math.sin(a) * r) * s);
    }
  }

  /** Anneau horizontal : impact au sol, couronne de poussiere. */
  ring(kind, center, radius, n, speed = 0.5) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const c = Math.cos(a), s = Math.sin(a);
      this.spawn(kind,
        center.x + c * radius, center.y + 0.01, center.z + s * radius,
        c * speed * (0.6 + Math.random() * 0.8),
        speed * (0.35 + Math.random() * 0.5),
        s * speed * (0.6 + Math.random() * 0.8));
    }
  }

  /**
   * Flux continu : `perSecond` particules par seconde, avec accumulateur
   * fractionnaire pour rester exact meme a 144 fps.
   */
  stream(kind, x, y, z, perSecond, dt, o = {}) {
    this._acc += perSecond * dt;
    const n = Math.floor(this._acc);
    this._acc -= n;
    if (n > 0) {
      this.burst(kind, x, y, z, Math.min(n, 24),
        { ...o, dir: o.down ? [0, -1, 0] : [0, 1, 0] });
    }
  }

  // --- simulation ----------------------------------------------------------

  update(dt) {
    const px = this.px, vx = this.vx, life = this.life;
    // Rafraichissement paresseux du sol : 1/8 des particules par frame. Le
    // sable bouge sous les particules pendant qu'elles volent (avalanches),
    // mais une erreur de 4 cm pendant 1/8 de seconde est invisible.
    const gsStride = 8;
    let n = this.count;

    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) { this._kill(i); n = this.count; i--; continue; }

      const k = this.kind[i] | 0;
      const K = KIND[k];
      const i3 = i * 3;

      // Gravite + trainee lineaire : nous ne simulons pas un ecoulement,
      // seulement une jolie chute.
      vx[i3 + 1] -= 9.81 * K[1] * dt;
      const drag = Math.max(0, 1 - K[3] * dt * 6);
      vx[i3] *= drag; vx[i3 + 1] *= drag; vx[i3 + 2] *= drag;

      px[i3] += vx[i3] * dt;
      px[i3 + 1] += vx[i3 + 1] * dt;
      px[i3 + 2] += vx[i3 + 2] * dt;

      if ((i + this._gsCursor) % gsStride === 0) {
        this.ground[i] = this.field.surfaceHeightAt(px[i3], px[i3 + 2]);
      }

      // --- collision avec le sable -----------------------------------------
      if (px[i3 + 1] <= this.ground[i]) {
        px[i3 + 1] = this.ground[i];
        if (k === 2 || k === 4 || k === 5 || k === 1) { this._kill(i); n = this.count; i--; continue; }
        if (k === 3) {
          // Le retour visuel precede la consequence physique : cause -> image
          // -> effet.
          if (this.seed[i] < 0.125 && this._wet) {
            this._wet(px[i3], px[i3 + 1], px[i3 + 2]);
          }
          this._kill(i); n = this.count; i--; continue;
        }
        // Grain sec : un rebond mou, puis il meurt vite.
        if (vx[i3 + 1] < -0.25) {
          vx[i3 + 1] *= -0.25;
          vx[i3] *= 0.55; vx[i3 + 2] *= 0.55;
          life[i] = Math.min(life[i], 0.22);
        } else { this._kill(i); n = this.count; i--; continue; }
      }
    }
    this._gsCursor++;

    // --- upload ------------------------------------------------------------
    const d = this.data;
    for (let i = 0; i < n; i++) {
      const k = this.kind[i] | 0;
      d[i * 4] = k;
      d[i * 4 + 1] = this.life[i] / this.life0[i];
      d[i * 4 + 2] = this.seed[i];
      d[i * 4 + 3] = KIND[k][0];
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aData.needsUpdate = true;
  }

  /** Suppression par echange avec le dernier : O(1), pas de trou dans le pool. */
  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    for (let c = 0; c < 3; c++) {
      this.px[i * 3 + c] = this.px[last * 3 + c];
      this.vx[i * 3 + c] = this.vx[last * 3 + c];
    }
    this.life[i] = this.life[last];
    this.life0[i] = this.life0[last];
    this.kind[i] = this.kind[last];
    this.ground[i] = this.ground[last];
    this.seed[i] = this.seed[last];
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
