/**
 * Le VOLUME d'eau, vu de côté.
 *
 * Une nappe d'eau rendue comme une simple surface trahit immédiatement le
 * truc : de profil, la mer est une feuille de papier posée sur le sable, avec
 * une tranche vide en dessous — la surface semble FLOTTER au bord du diorama.
 * Sur un objet qu'on regarde sous tous les angles, y compris à hauteur de
 * table, c'est rédhibitoire.
 *
 * On ajoute donc une "jupe" : une ceinture de quads verticaux le long du
 * pourtour du domaine, qui descend de la surface libre jusqu'au fond. Elle est
 * pilotée par la MÊME texture de champ que la surface, donc elle suit la marée,
 * les vagues et le creusement sans aucune synchronisation à écrire.
 *
 * Son shader est une VITRE D'AQUARIUM, pas un mur peint. Quand la capture du
 * décor existe, chaque pixel de la jupe lit la profondeur de la scène derrière
 * lui, en déduit la longueur du trajet du rayon DANS l'eau jusqu'au fond, et
 * applique l'absorption de Beer-Lambert et la diffusion sur ce trajet : le
 * fond proche reste clair et turquoise, le fond lointain vire au bleu profond.
 * C'est exactement ce qu'on voit à travers la paroi d'un aquarium. La version
 * ancienne — une tranche uniformément turquoise — se lisait comme un mur.
 */

import * as THREE from 'three';
import {
  NX, NZ, VOXEL, WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z,
} from '../core/Config.js';

const VERT = /* glsl */ `
uniform sampler2D uField;
uniform float uTime;

attribute float aSide;   // 0 = fond, 1 = surface libre
attribute vec2 aFieldUv;
attribute vec3 aNormal;  // normale sortante de la face du diorama

varying vec3 vWorldPos;
varying float vDepthBelow;   // hauteur d'eau au-dessus de ce point
varying float vTotalDepth;   // hauteur d'eau totale de la colonne
varying float vSide;
varying vec2 vFieldUv;
varying vec3 vFaceNormal;
varying vec4 vClipPosition;

void main() {
  vec4 f = texture2D(uField, aFieldUv);
  float level = f.r;          // altitude de la surface libre
  float depth = f.g;          // hauteur d'eau
  float bed = level - depth;  // altitude du fond

  vFieldUv = aFieldUv;
  vTotalDepth = depth;
  vSide = aSide;
  vFaceNormal = aNormal;

  // Le sommet du haut suit la surface, celui du bas colle au fond (avec une
  // marge sous le fond : la jupe ne doit jamais laisser un jour au-dessus du
  // sable si la colonne de bord est un peu plus haute que la texture).
  float y = mix(bed - 0.05, level, aSide);
  vDepthBelow = level - y;

  vec3 p = vec3(position.x, y, position.z);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  vClipPosition = gl_Position;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uTime;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2 uSceneTexel;
uniform float uRefractionEnabled;
uniform float uCameraNear;
uniform float uCameraFar;

varying vec3 vWorldPos;
varying float vDepthBelow;
varying float vTotalDepth;
varying float vSide;
varying vec2 vFieldUv;
varying vec3 vFaceNormal;
varying vec4 vClipPosition;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float sceneDepthToViewZ(float depth) {
  return (uCameraNear * uCameraFar) /
    ((uCameraFar - uCameraNear) * depth - uCameraFar);
}

void main() {
  // Pas d'eau ici : pas de tranche.
  if (vTotalDepth < 0.004) discard;
  // Sous le fond (marge du sommet bas) : le sable est devant de toute facon.
  if (vDepthBelow > vTotalDepth + 0.002) discard;

  float d = max(vDepthBelow, 0.0);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vFaceNormal);
  // Une jupe vue de l'interieur (camera dans le domaine) est retournee.
  if (dot(N, V) < 0.0) N = -N;

  vec3 SIGMA = vec3(2.10, 0.30, 0.20);
  vec3 col;
  float alpha;

  if (uRefractionEnabled > 0.5) {
    // --- vitre d'aquarium : trajet du rayon dans l'eau jusqu'au fond -------
    vec2 uv = vClipPosition.xy / max(vClipPosition.w, 1e-5) * 0.5 + 0.5;
    uv = clamp(uv, uSceneTexel, 1.0 - uSceneTexel);
    float sceneDepth = texture2D(uSceneDepth, uv).r;
    float fragZ = (viewMatrix * vec4(vWorldPos, 1.0)).z;
    float sceneZ = sceneDepth >= 0.9999 ? -uCameraFar : sceneDepthToViewZ(sceneDepth);
    float distFrag = length(cameraPosition - vWorldPos);
    // Le long d'un rayon de vue, la distance est proportionnelle a la
    // profondeur de vue : L = distance(fragment -> scene) dans l'eau.
    float L = clamp(distFrag * (sceneZ / min(fragZ, -1e-4) - 1.0), 0.0, 3.5);
    vec3 scene = texture2D(uSceneColor, uv).rgb;
    vec3 trans = exp(-SIGMA * L * 1.25);
    vec3 inscatter = mix(uShallow, uDeep, 1.0 - exp(-L * 0.9)) * (1.0 - trans) * 0.72;
    col = scene * trans + inscatter;
    alpha = 1.0;
  } else {
    // --- repli analytique (qualite basse) ----------------------------------
    vec3 trans = exp(-SIGMA * d * 1.9);
    col = mix(uDeep, uShallow, trans);
    alpha = clamp(0.42 + 0.55 * (1.0 - exp(-d * 3.2)), 0.0, 0.96);
  }

  // --- lentille de lumiere sous la surface --------------------------------
  // Les premiers centimetres sont nettement plus clairs : c'est la lumiere qui
  // rentre par la surface et qu'on voit par la tranche.
  float lens = exp(-d * 9.0);
  col += uSunColor * lens * 0.22 * max(uSunDir.y, 0.15);

  // --- particules en suspension -------------------------------------------
  // Elles montent lentement et scintillent : c'est ce qui donne l'echelle et
  // fait lire l'eau comme un volume plutot que comme un aplat.
  vec3 pp = vWorldPos * 26.0 + vec3(0.0, -uTime * 0.35, 0.0);
  float motes = vnoise3(pp) * vnoise3(pp * 2.1 + 13.0);
  motes = smoothstep(0.42, 0.72, motes);
  col += vec3(0.85, 0.95, 1.0) * motes * 0.12 * exp(-d * 1.6);

  // Rais de lumiere : de longues stries verticales qui ondulent doucement,
  // la signature de la lumiere qui traverse une surface agitee.
  float rays = vnoise3(vec3(vWorldPos.xz * 3.0 + vec2(uTime * 0.12, -uTime * 0.08), vWorldPos.y * 0.4));
  rays = smoothstep(0.55, 0.85, rays) * exp(-d * 2.2);
  col += uSunColor * rays * 0.10 * max(uSunDir.y, 0.0);

  // --- ligne de flottaison -------------------------------------------------
  // Un lisere clair juste sous la surface : la refraction totale y concentre
  // la lumiere. Sans lui, le haut de la tranche parait coupe au cutter.
  float rim = smoothstep(0.022, 0.0, d);
  col = mix(col, vec3(0.88, 0.97, 1.0), rim * 0.32);

  // --- reflet de vitre -------------------------------------------------------
  // La coupe est une paroi imaginaire ; un soupcon de Fresnel vers le ciel en
  // incidence rasante lui donne la lecture « vitre » plutot que « mur ».
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));
  col = mix(col, sky, fres * 0.55);

  // Assombrissement au contact du fond (l'eau y est plus chargee).
  float bedShade = smoothstep(0.06, 0.0, vTotalDepth - d);
  col *= 1.0 - 0.18 * bedShade;

  alpha *= smoothstep(0.004, 0.03, vTotalDepth);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaterVolume {
  /**
   * @param {THREE.Scene} scene
   * @param {object} shared uniformes partages avec la surface
   */
  constructor(scene, shared) {
    this.scene = scene;

    const geo = buildSkirtGeometry();

    this.uniforms = {
      uField: shared.uField,
      uTime: shared.uTime,
      uShallow: shared.uShallow,
      uDeep: shared.uDeep,
      uSunColor: shared.uSunColor,
      uSunDir: shared.uSunDir,
      uSkyZenith: shared.uSkyZenith,
      uSkyHorizon: shared.uSkyHorizon,
      uSceneColor: shared.uSceneColor,
      uSceneDepth: shared.uSceneDepth,
      uSceneTexel: shared.uSceneTexel,
      uRefractionEnabled: shared.uRefractionEnabled,
      uCameraNear: shared.uCameraNear,
      uCameraFar: shared.uCameraFar,
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'waterVolume';
    this.mesh.frustumCulled = false;
    // Juste avant la surface : la tranche est derriere elle quand on regarde
    // de biais, et devant le sable.
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Construit la ceinture : quatre bandes de quads verticaux le long du
 * pourtour du domaine, deux sommets par colonne (fond et surface).
 */
function buildSkirtGeometry() {
  const pos = [];
  const side = [];
  const uvs = [];
  const nrm = [];
  const idx = [];

  // Demi-texel : on echantillonne au centre des cellules de bord, jamais sur
  // l'arete, pour eviter le clamp de la texture.
  const hu = 0.5 / NX;
  const hv = 0.5 / NZ;

  /** Ajoute une bande le long d'un bord. */
  function edge(count, nx, nz, fn) {
    const base = pos.length / 3;
    for (let i = 0; i < count; i++) {
      const { x, z, u, v } = fn(i / (count - 1));
      // bas puis haut
      pos.push(x, 0, z); side.push(0); uvs.push(u, v); nrm.push(nx, 0, nz);
      pos.push(x, 0, z); side.push(1); uvs.push(u, v); nrm.push(nx, 0, nz);
    }
    for (let i = 0; i < count - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  // Un demi-centimetre HORS du domaine : la face de coupe du sable est
  // exactement sur le plan du bord, et deux surfaces coplanaires se disputent
  // le pixel (z-fighting). Le decalage est invisible.
  const OUT = 0.006;
  const x0 = ORIGIN_X - OUT, x1 = ORIGIN_X + WORLD_W + OUT;
  const z0 = ORIGIN_Z - OUT, z1 = ORIGIN_Z + WORLD_D + OUT;
  // Une colonne de texture par segment : la jupe suit exactement la ligne
  // d'eau de la texture, sans marche ni jour.
  const N = Math.max(NX, NZ);

  // Bord z = z0
  edge(N, 0, -1, (t) => ({ x: x0 + (WORLD_W + 2 * OUT) * t, z: z0, u: hu + (1 - 2 * hu) * t, v: hv }));
  // Bord z = z1
  edge(N, 0, 1, (t) => ({ x: x0 + (WORLD_W + 2 * OUT) * t, z: z1, u: hu + (1 - 2 * hu) * t, v: 1 - hv }));
  // Bord x = x0
  edge(N, -1, 0, (t) => ({ x: x0, z: z0 + (WORLD_D + 2 * OUT) * t, u: hu, v: hv + (1 - 2 * hv) * t }));
  // Bord x = x1
  edge(N, 1, 0, (t) => ({ x: x1, z: z0 + (WORLD_D + 2 * OUT) * t, u: 1 - hu, v: hv + (1 - 2 * hv) * t }));

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aFieldUv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aNormal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 12);
  return g;
}
