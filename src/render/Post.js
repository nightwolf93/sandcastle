/**
 * Post-traitement — c'est ce qui transforme "une plage en 3D" en "une maquette
 * posee sur une table".
 *
 * Chaine :
 *   scene (HDR lineaire, MSAA) -> bloom -> rayons -> tone mapping + sRGB
 *   -> SMAA -> etalonnage
 *
 * Deux anti-crenelages, parce qu'ils ne traitent pas les memes aretes. Le
 * MSAA du rendu principal lisse les silhouettes geometriques : creneaux,
 * brins d'oyat, bord du bloc (l'`antialias: true` du renderer ne sert a rien
 * des qu'on rend dans une texture). Il ne concerne QUE la passe de scene : la
 * scene est rendue dans une cible multi-echantillons a part, resolue une
 * seule fois, puis recopiee dans le composer dont les cibles restent
 * ordinaires. Faire ecrire chaque passe dans une cible multi-echantillons
 * coutait une resolution par passe et passait par un chemin fragile de
 * certains pilotes. Le SMAA, lui, rattrape les aretes nees dans les shaders
 * (ligne d'eau, ombres, reflets) — et il passe AVANT le grain, sinon le
 * grain masque les contours qu'il doit trouver.
 *
 * L'ORDRE compte enormement. Le bloom doit voir de la lumiere lineaire non
 * bornee, sinon il n'a rien a faire ressortir. L'etalonnage, lui, doit venir
 * APRES le tone mapping : lever les noirs ou ajouter du grain sur des valeurs
 * lineaires produit un voile laiteux, parce qu'un +0.01 lineaire dans les
 * ombres devient un +0.1 apres la courbe. Les memes chiffres appliques en
 * sRGB font exactement ce qu'on attend.
 *
 * L'etalonnage regroupe volontairement quatre effets dans une seule passe
 * (une passe = un aller-retour de framebuffer, c'est ce qui coute) :
 *   1. TILT-SHIFT. Un flou progressif hors d'une bande horizontale nette.
 *      C'est LE signal de "miniature" : notre cerveau associe une faible
 *      profondeur de champ a un petit objet vu de pres.
 *   2. ABERRATION CHROMATIQUE radiale, tres legere — l'objectif macro.
 *   3. ETALONNAGE chaud : ombres tirees vers le cyan, hautes lumieres vers
 *      l'ambre, saturation legerement poussee.
 *   4. VIGNETTAGE et GRAIN, pour casser la proprete du rendu de synthese.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Recopie de la scene dans le composer, ASSAINIE. Un seul pixel NaN ou infini
 * dans la scene HDR (un normalize() sur un vecteur nul, une division par
 * zero dans un shader, sous un angle de camera precis) est etale par le bloom
 * sur l'ecran entier : une image noire. Ici, un NaN devient un pixel noir et
 * une valeur folle est bornee. C'est une passe de copie, elle ne coute rien
 * de plus que celle qu'elle remplace.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // NaN est le seul nombre different de lui-meme.
      if (c.r != c.r) c.r = 0.0;
      if (c.g != c.g) c.g = 0.0;
      if (c.b != c.b) c.b = 0.0;
      gl_FragColor = vec4(clamp(c, 0.0, 48.0), 1.0);
    }
  `,
};

class SanitizePass extends Pass {
  constructor(texture) {
    super();
    this.needsSwap = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: texture } },
      vertexShader: SanitizeShader.vertexShader,
      fragmentShader: SanitizeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GodRaysShader, updateGodRays } from './GodRays.js';

const DioramaShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    /** Centre vertical de la bande nette (0 en bas, 1 en haut). */
    uFocus: { value: 0.5 },
    /** Demi-hauteur de la bande parfaitement nette. */
    uFocusArea: { value: 0.42 },
    /** Longueur du degrade net -> flou. */
    uFeather: { value: 0.30 },
    /**
     * Rayon de flou maximal, en fraction de l'ecran.
     * Tres modeste : le tilt-shift doit se deviner, pas se voir. Des qu'il
     * mord sur le sujet, la maquette devient une photo ratee.
     */
    uBlur: { value: 0.0022 },
    // En fraction d'ecran. Tres discret : sur de la geometrie fine et
    // contrastee (les brins d'oyat), meme 1,5 px de frange se lit comme un
    // liseré magenta et cyan. On reste sous le pixel.
    uAberration: { value: 0.0005 },
    uVignette: { value: 0.22 },
    // Applique apres tone mapping, donc en sRGB : ces valeurs sont lisibles
    // telles quelles. 0.02 de grain est deja bien visible.
    uGrain: { value: 0.020 },
    uSaturation: { value: 1.30 },
    // Les basses lumieres tirent au bleu (le ciel les remplit), les hautes
    // tirent a l'ambre (le soleil). Split-toning classique, et le seul reglage
    // qui rechauffe une image sans la jaunir dans les ombres.
    uLift: { value: new THREE.Vector3(-0.016, -0.002, 0.026) },
    uGain: { value: new THREE.Vector3(1.075, 1.012, 0.928) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uFocus;
    uniform float uFocusArea;
    uniform float uFeather;
    uniform float uBlur;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSaturation;
    uniform vec3 uLift;
    uniform vec3 uGain;
    varying vec2 vUv;

    // 12 directions en spirale : un disque de Poisson bon marche.
    const vec2 TAPS[12] = vec2[12](
      vec2( 0.9689, 0.2474), vec2( 0.4818, 0.8763), vec2(-0.2225, 0.9749),
      vec2(-0.8090, 0.5878), vec2(-0.9945, 0.1045), vec2(-0.7290,-0.6845),
      vec2(-0.1045,-0.9945), vec2( 0.5000,-0.8660), vec2( 0.9511,-0.3090),
      vec2( 0.3090, 0.4540), vec2(-0.5878,-0.2079), vec2( 0.1564,-0.4067)
    );

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uResolution.x / uResolution.y;

      // --- masque de tilt-shift ---
      float d = abs(uv.y - uFocus);
      float blurAmt = smoothstep(uFocusArea, uFocusArea + uFeather, d);
      blurAmt = blurAmt * blurAmt; // progression douce puis franche

      // --- aberration chromatique radiale ---
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      vec2 ca = c * uAberration * (1.0 + 2.5 * r2);

      // Image nette, avec les franges colorees de l'objectif.
      vec3 sharp = vec3(
        texture2D(tDiffuse, uv + ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - ca).b
      );

      vec3 col = sharp;
      if (blurAmt > 0.004) {
        float radius = uBlur * blurAmt;
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        float lumC = dot(sharp, vec3(0.2126, 0.7152, 0.0722));
        // Rotation aleatoire par pixel : casse le motif du disque.
        float a = hash12(uv * uResolution) * 6.2831;
        float ca2 = cos(a), sa = sin(a);
        for (int i = 0; i < 12; i++) {
          vec2 t = TAPS[i];
          vec2 rt = vec2(t.x * ca2 - t.y * sa, t.x * sa + t.y * ca2);
          vec2 off = rt * radius * vec2(1.0 / aspect, 1.0);
          vec3 s = texture2D(tDiffuse, uv + off).rgb;
          // Garde-fou anti-bavure : un echantillon beaucoup plus clair que le
          // centre (typiquement le fond derriere une silhouette) est fortement
          // attenue. Sans ca, chaque contour du diorama se borde d'un halo.
          float lumS = dot(s, vec3(0.2126, 0.7152, 0.0722));
          float w = (1.0 - 0.35 * length(t)) / (1.0 + max(0.0, lumS - lumC) * 3.5);
          acc += s * w;
          wsum += w;
        }
        acc /= max(wsum, 1e-4);
        col = mix(sharp, acc, clamp(blurAmt * 1.15, 0.0, 1.0));
      }

      // --- etalonnage ---
      col = col * uGain + uLift;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);
      // Un soupcon de contraste en S sur les tons moyens.
      col = mix(col, col * col * (3.0 - 2.0 * clamp(col, 0.0, 1.0)), 0.07);

      // --- vignettage ---
      float vig = 1.0 - uVignette * pow(clamp(r2 * 2.0, 0.0, 1.0), 1.35);
      col *= vig;

      // --- grain ---
      float g = hash12(uv * uResolution + fract(uTime) * 137.0) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - clamp(lum, 0.0, 1.0)));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class Post {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.time = 0;

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.floor(size.x * pr), h = Math.floor(size.y * pr);

    // La scene est rendue ici, en HDR multi-echantillons, puis resolue une
    // seule fois. Le composer, lui, garde ses cibles ordinaires.
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.sceneTarget.texture.name = 'postScene';
    this.samplesWanted = 4;

    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);
    this.composer.setPixelRatio(pr);

    this.scenePass = new SanitizePass(this.sceneTarget.texture);
    this.composer.addPass(this.scenePass);
    // `?msaa=0` (ou 2, 4) force le nombre d'echantillons : pour isoler un
    // probleme de pilote sans toucher au code.
    const forced = typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('msaa') : null;
    this.samplesForced = forced == null ? null : Math.max(0, Math.min(4, +forced | 0));

    // Bloom discret : il ne doit se voir que sur les scintillements de quartz
    // et les reflets du soleil sur l'eau.
    // Le seuil doit etre ATTEIGNABLE : a 1.45 la passe etait un no-op, la
    // scene plafonnant bien en dessous. A 1.10, seuls le disque solaire, les
    // eclats sur l'eau et le sable au soleil rasant le franchissent.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.26, 0.28, 1.50);
    this.bloom.smoothWidth = 0.35;
    this.composer.addPass(this.bloom);

    // Rayons de soleil, en lumiere lineaire : c'est la seule etape ou le ciel
    // depasse franchement la maquette en luminance.
    this.godRays = new ShaderPass(GodRaysShader);
    this.godRays.uniforms.uResolution.value.set(w, h);
    this.composer.addPass(this.godRays);

    // Tone mapping + conversion sRGB AVANT l'etalonnage : voir l'en-tete.
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.grade = new ShaderPass(DioramaShader);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.composer.addPass(this.grade);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.godRayStrength = 0.85;
  }



  setSize(w, h) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    const pw = Math.floor(w * pr), ph = Math.floor(h * pr);
    this.sceneTarget.setSize(pw, ph);
    this.grade.uniforms.uResolution.value.set(pw, ph);
    this.godRays.uniforms.uResolution.value.set(pw, ph);
    this.bloom.setSize(pw, ph);
    this.applySamples();
  }

  /**
   * Nombre d'echantillons MSAA demande (0, 2 ou 4). Le nombre effectif
   * depend aussi de la taille de l'image : a 4 echantillons, une cible HDR
   * de 15 Mpx (1440p sur un ecran HiDPI) pese pres d'un demi-gigaoctet. On
   * redescend a 2 au-dela de 4 Mpx, et on laisse le SMAA seul au-dela de 8.
   */
  setSamples(n) {
    this.samplesWanted = n;
    this.applySamples();
  }

  applySamples() {
    const rt = this.sceneTarget;
    const pixels = rt.width * rt.height;
    let n = this.samplesForced ?? this.samplesWanted ?? 4;
    if (pixels > 8e6) n = 0;
    else if (pixels > 4e6) n = Math.min(n, 2);
    if (rt.samples === n) return;
    rt.samples = n;
    rt.dispose();
  }

  /** Le mode photo pousse le tilt-shift et enleve le grain. */
  setPhotoMode(on) {
    const u = this.grade.uniforms;
    u.uBlur.value = on ? 0.0042 : 0.0022;
    u.uFocusArea.value = on ? 0.30 : 0.42;
    u.uGrain.value = on ? 0.012 : 0.020;
    u.uVignette.value = on ? 0.34 : 0.26;
    this.bloom.strength = on ? 0.24 : 0.17;
  }

  /**
   * Recentre la bande nette sur un point du monde — en pratique la ou le
   * joueur travaille. Sans ca, la bande reste au milieu de l'ecran et floute
   * le sommet des tours des qu'on se rapproche.
   * @param {THREE.Vector3} worldPos
   * @param {number} dt
   */
  focusOn(worldPos, dt = 0.016) {
    this._v = this._v || new THREE.Vector3();
    this._v.copy(worldPos).project(this.camera);
    const y = (this._v.y + 1) * 0.5;
    if (!Number.isFinite(y)) return;
    const u = this.grade.uniforms;
    const k = 1 - Math.pow(0.02, dt);
    u.uFocus.value += (Math.max(0.12, Math.min(0.88, y)) - u.uFocus.value) * k;
  }

  render(dt) {
    this.time += dt;
    this.grade.uniforms.uTime.value = this.time;
    updateGodRays(this.godRays, this.sunDir, this.camera, this.godRayStrength);
    if (!this.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // Passe de scene : dans la cible multi-echantillons, resolue au moment
    // ou l'on en sort. Le composer lit ensuite la texture resolue.
    const r = this.renderer;
    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    this.composer.render(dt);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.scenePass.dispose();
    this.composer.dispose?.();
    this.bloom.dispose?.();
    this.smaa.dispose?.();
  }
}
