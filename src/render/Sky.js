/**
 * Ciel procedural + cycle solaire + generation de l'environnement IBL.
 *
 * Le ciel est un dome inverse avec un degrade de diffusion atmospherique
 * simplifie (Rayleigh pour le bleu du zenith, Mie pour le halo autour du
 * soleil). Il sert aussi de source d'eclairage indirect : on le rend dans une
 * cube map via PMREMGenerator, rafraichie seulement quand le soleil a
 * sensiblement bouge.
 */

import * as THREE from 'three';
import { WORLD_W, WORLD_D } from '../core/Config.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // toujours au fond
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGroundNear;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uHaze;
uniform float uNight;
uniform float uClouds;
uniform float uTime;

float sk_hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sk_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sk_hash(i), sk_hash(i + vec2(1, 0)), f.x),
             mix(sk_hash(i + vec2(0, 1)), sk_hash(i + vec2(1, 1)), f.x), f.y);
}
float sk_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * sk_noise(p); p = p * 2.1 + 17.0; a *= 0.5; }
  return s / 0.9375;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // Degrade zenith -> horizon.
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 sky = mix(uHorizon, uZenith, t);

  // Sous l'horizon : le large. La mer s'eclaircit en approchant de l'horizon
  // (elle y reflechit le ciel a incidence rasante) et s'assombrit vers nous.
  // Sans ce degrade, le fond est un aplat de peinture bleue.
  vec3 sea = mix(uGround, uGroundNear, smoothstep(-0.42, -0.005, h));
  sky = mix(sea, sky, smoothstep(-0.012, 0.012, h));

  // Fine brume a la ligne d'horizon.
  sky = mix(sky, mix(uHorizon, uGroundNear, 0.5) * 1.12,
            exp(-abs(h) * 90.0) * 0.35);

  // Diffusion de Mie : halo autour du soleil
  float cosA = dot(d, uSunDir);
  // Un seul lobe, serre. Le second lobe large (exposant 2) repandait un voile
  // laiteux sur la totalite du ciel.
  float mie = pow(max(cosA, 0.0), 12.0) * 0.55;
  sky += uSunColor * mie * uHaze;

  // Disque solaire
  float disc = smoothstep(uSunSize, uSunSize * 0.55, acos(clamp(cosA, -1.0, 1.0)));
  sky += uSunColor * disc * 12.0 * (1.0 - uNight);

  // Etoiles la nuit
  if (uNight > 0.01 && h > -0.02) {
    vec3 p = floor(d * 620.0);
    float n = fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    float star = smoothstep(0.9975, 0.9999, n);
    sky += vec3(0.8, 0.85, 1.0) * star * uNight * smoothstep(0.0, 0.25, h);
  }

  // Nuages : une couche haute projetee sur le dome, qui derive lentement.
  // Beau temps : quelques cirrus blancs, eclaires par le soleil. Temps
  // couvert (uClouds monte avec la meteo) : une masse grise et plate qui
  // mange le disque solaire. Le meme dome sert a l'eclairage indirect, donc
  // la lumiere de la scene suit.
  if (h > 0.01) {
    vec2 cp = d.xz / (h + 0.14) * 1.9 + vec2(uTime * 0.006, uTime * 0.0025);
    float cov = sk_fbm(cp);
    float cover = smoothstep(0.64 - uClouds * 0.52, 0.88 - uClouds * 0.36, cov)
                * smoothstep(0.01, 0.16, h);
    float towardSun = pow(max(cosA, 0.0), 6.0);
    vec3 fair = vec3(1.0, 0.985, 0.96) * (0.85 + 0.55 * towardSun) * (0.55 + 0.45 * max(uSunDir.y, 0.0));
    vec3 gloom = vec3(0.50, 0.53, 0.58) * (0.35 + 0.65 * max(uSunDir.y, 0.0));
    vec3 cloud = mix(fair, gloom, uClouds) * (1.0 - uNight * 0.85);
    sky = mix(sky, cloud, cover * (0.75 + 0.25 * uClouds));
  }

  gl_FragColor = vec4(sky, 1.0);
}
`;

/**
 * Inclinaison de l'arc solaire (rad).
 * A 0.20 le soleil culmine a 78 degres au lieu de 68 : les ombres de midi sont
 * deux fois plus courtes, et la scene lit "tropical" au lieu de "printemps
 * europeen". C'est le reglage le moins cher du document meteo.
 */
const ARC_TILT = 0.20;

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
      uZenith: { value: new THREE.Color(0x2f6fc4) },
      uHorizon: { value: new THREE.Color(0xbfd8ea) },
      uGround: { value: new THREE.Color(0x0a3a52) },
      uGroundNear: { value: new THREE.Color(0x1d7f8c) },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.78) },
      uSunSize: { value: 0.028 },
      uHaze: { value: 0.7 },
      uNight: { value: 0 },
      uClouds: { value: 0.3 },
      uTime: { value: 0 },
    };

    /**
     * Couverture du ciel, 0..1 (voir core/Weather.js). Un ciel couvert est
     * gris et plat : le soleil s'efface, le remplissage monte, la brume
     * s'epaissit. C'est la lumiere de la tempete.
     */
    this.overcast = 0;
    this.lastEnvOvercast = 0;

    const geo = new THREE.SphereGeometry(1, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    // Le dome reste centre sur la camera : rayon 1 suffit puisqu'on force
    // gl_Position.z = w (profondeur maximale) dans le vertex shader.
    this.mesh.onBeforeRender = (r, s, cam) => {
      this.mesh.position.copy(cam.position);
      this.mesh.updateMatrixWorld(true);
    };
    scene.add(this.mesh);

    // --- lumieres ---
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 40;
    // Cadrage serre : la scene tient dans 10 m, chaque metre de rab coute de
    // la resolution d'ombre.
    // Le domaine fait 12,8 m de cote : sa diagonale projetee demande 9 m.
    // 0,74 fois le grand cote couvre la diagonale ; jamais moins que
    // la valeur reglee pour 12,8 m.
    const S = Math.max(9.4, 0.74 * Math.max(WORLD_W, WORLD_D));
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    // normalBias de 3 cm decollait litteralement les ombres des creneaux, qui
    // font 4 cm. A 6 mm, l'ombre reste attachee a l'objet.
    // `bias` decale en profondeur, ce qui ne sert a rien quand la surface est
    // presque parallele au rayon : la marche de profondeur d'un texel devient
    // enorme et produit des rayures regulieres. C'est `normalBias`, qui
    // deplace le point de test LE LONG DE LA NORMALE, qui traite ce cas —
    // c'est exactement le probleme des faces de coupe du bloc, rasees par le
    // soleil. On le monte donc franchement et on relache l'autre.
    this.sun.shadow.bias = -0.00004;
    this.sun.shadow.normalBias = 0.028;
    // Une penombre trop large delave le contact au sol et c'est exactement ce
    // qui donnait l'impression que rien ne posait d'ombre.
    this.sun.shadow.radius = 0.7;
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Le ciel bleu est une enorme source diffuse : sans un remplissage
    // genereux, tout ce qui n'est pas au soleil vire au noir et la maquette
    // perd son cote "objet pose sur une table bien eclairee".
    // Le remplissage doit etre FAIBLE et FRANCHEMENT BLEU : c'est le ciel, pas
    // une boite a lumiere. C'est ce qui donne des ombres bleutees au lieu de
    // grises — et un remplissage trop fort est la cause n°1 d'une image lavee.
    this.fill = new THREE.HemisphereLight(0x6fa8e8, 0xc99a55, 0.22);
    scene.add(this.fill);

    // --- IBL ---
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(geo, mat);
    this.envSky.frustumCulled = false;
    this.envScene.add(this.envSky);
    this.envTarget = null;
    this.lastEnvSunY = -99;

    // ~09h50. Plus haut, le soleil aplatit tout : sur une plage horizontale,
    // c'est l'INCLINAISON qui sculpte le relief, et une dune ne se lit qu'a
    // partir du moment ou elle projette une ombre. Plus bas, la maquette passe
    // la moitie de son temps dans son propre ombre.
    this.dayT = 0.325;
    this.update(this.dayT, true);
  }

  /** Direction du soleil (unitaire) pour une heure normalisee 0..1. */
  static sunDirection(dayT, out = new THREE.Vector3()) {
    const u = (dayT - 0.25) * 2; // 0 au lever, 1 au coucher
    const angle = u * Math.PI;
    out.set(
      Math.cos(angle),
      Math.sin(angle) * Math.cos(ARC_TILT),
      -Math.sin(angle) * Math.sin(ARC_TILT)
    );
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /**
   * @param {number} dayT heure normalisee 0..1 (0.5 = midi)
   * @param {boolean} force regenere l'IBL meme si le soleil a peu bouge
   */
  update(dayT, force = false) {
    this.dayT = dayT;
    const dir = Sky.sunDirection(dayT, this.uniforms.uSunDir.value);

    const elev = Math.max(dir.y, -0.25);
    const day = THREE.MathUtils.smoothstep(elev, -0.08, 0.16);
    const golden = 1 - THREE.MathUtils.smoothstep(Math.abs(elev), 0.05, 0.42);

    // Couleur du soleil : blanc chaud au zenith, orange rasant.
    const sunColor = this.uniforms.uSunColor.value;
    sunColor.setRGB(1.0, 0.957, 0.886).lerp(new THREE.Color(1.0, 0.52, 0.24), golden * 0.85);

    // Ciel
    // Zenith d'un ciel tropical : bleu profond et sature.
    this.uniforms.uZenith.value
      .setRGB(0.028, 0.155, 0.62)
      .lerp(new THREE.Color(0.02, 0.04, 0.11), 1 - day);
    this.uniforms.uHorizon.value
      .setRGB(0.34, 0.56, 0.82)
      .lerp(new THREE.Color(0.98, 0.63, 0.38), golden * 0.9)
      .lerp(new THREE.Color(0.05, 0.07, 0.16), (1 - day) * 0.9);
    // Sous l'horizon : pas un "sol", mais le fond de studio clair et chaud
    // qui donne la lecture "maquette posee sur une table".
    // Sous l'horizon : le large. Deux teintes — un bleu profond au premier
    // plan, un turquoise lumineux vers l'horizon. La maquette est un morceau
    // de cette plage, pas un objet pose sur une table.
    this.uniforms.uGround.value
      .setRGB(0.020, 0.105, 0.185)
      .lerp(new THREE.Color(0.14, 0.10, 0.10), golden * 0.5)
      .lerp(new THREE.Color(0.012, 0.028, 0.055), (1 - day) * 0.92);
    this.uniforms.uGroundNear.value
      .setRGB(0.075, 0.40, 0.46)
      .lerp(new THREE.Color(0.40, 0.30, 0.24), golden * 0.5)
      .lerp(new THREE.Color(0.02, 0.05, 0.09), (1 - day) * 0.92);
    this.uniforms.uHaze.value = 0.45 + golden * 0.9;
    this.uniforms.uNight.value = 1 - day;

    // Ciel couvert : tout glisse vers un gris bleute, uniformement.
    const oc = this.overcast;
    this.uniforms.uClouds.value = 0.3 + 0.7 * oc;
    this.uniforms.uTime.value = performance.now() * 0.001;
    if (oc > 0.001) {
      sunColor.lerp(new THREE.Color(0.74, 0.76, 0.80), oc * 0.65);
      this.uniforms.uZenith.value.lerp(new THREE.Color(0.30, 0.34, 0.40), oc * 0.85);
      this.uniforms.uHorizon.value.lerp(new THREE.Color(0.56, 0.59, 0.63), oc * 0.85);
      this.uniforms.uGround.value.lerp(new THREE.Color(0.10, 0.14, 0.18), oc * 0.6);
      this.uniforms.uGroundNear.value.lerp(new THREE.Color(0.22, 0.30, 0.34), oc * 0.6);
      this.uniforms.uHaze.value += oc * 0.6;
    }

    // Lumiere directionnelle
    const dist = 18;
    this.sun.position.set(dir.x * dist, Math.max(dir.y, 0.02) * dist, dir.z * dist);
    this.sun.color.copy(sunColor);
    // Ratio soleil/ciel d'un vrai plein soleil : pres de 6 pour 1. Sous ce
    // rapport, l'image parait toujours lavee, quelle que soit la courbe de
    // tone mapping qu'on lui applique ensuite. Avec un remplissage a 0,22 et
    // un environnement a 0,62, on y est.
    this.sun.intensity = 5.4 * day * (1 - 0.62 * oc);
    this.sun.visible = day > 0.02;

    this.fill.color.copy(this.uniforms.uHorizon.value);
    this.fill.groundColor.setRGB(0.72, 0.60, 0.42).multiplyScalar(0.4 + 0.6 * day);
    // Le rapport soleil / remplissage EST le contraste. A 0.22 de remplissage
    // pour 5.0 de soleil, les faces a l'ombre remontaient trop haut et la
    // maquette paraissait posee dans une boite a lumiere.
    this.fill.intensity = 0.05 + 0.20 * day + 0.10 * day * oc;

    // Lune : petite lumiere froide quand il fait nuit
    if (!this.moon) {
      this.moon = new THREE.DirectionalLight(0x9fb6d8, 0);
      this.scene.add(this.moon);
    }
    this.moon.position.set(-dir.x * dist, Math.max(-dir.y, 0.05) * dist, -dir.z * dist);
    this.moon.intensity = 0.55 * (1 - day);

    // IBL : regenere quand la hauteur du soleil a change de plus de 3 %
    if (force || Math.abs(dir.y - this.lastEnvSunY) > 0.03
        || Math.abs(oc - this.lastEnvOvercast) > 0.08) {
      this.lastEnvSunY = dir.y;
      this.lastEnvOvercast = oc;
      this.regenerateEnvironment();
    }
  }

  regenerateEnvironment() {
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.78;
  }

  get sunDir() {
    return this.uniforms.uSunDir.value;
  }

  /** Facteur d'ensoleillement 0..1 (pour l'evaporation). */
  get insolation() {
    return Math.max(0, this.uniforms.uSunDir.value.y);
  }

  dispose() {
    this.pmrem.dispose();
    if (this.envTarget) this.envTarget.dispose();
  }
}
