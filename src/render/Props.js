/**
 * Décor : tout ce qui pousse, traîne ou se pose sur la plage et sous l'eau.
 *
 * Rochers, coquillages, oyats, drapeaux, mais surtout — et c'est le plus gros
 * apport visuel du projet — le RÉCIF : herbiers, algues, coraux, gorgones,
 * oursins. C'est ce qu'on voit à travers l'eau turquoise qui donne toute sa
 * profondeur à l'image ; un fond de sable nu reste plat quelle que soit la
 * qualité du shader d'eau au-dessus.
 *
 * Tout est généré en code (aucun asset) et rendu en InstancedMesh : quelques
 * milliers d'objets pour une trentaine d'appels de dessin.
 *
 * Deux traitements distincts :
 *
 *  - LES OBJETS ÉMERGÉS utilisent un matériau standard, avec une ondulation
 *    de vent saccadée pour la végétation.
 *  - LES OBJETS IMMERGÉS lisent la texture du champ d'eau pour connaître la
 *    hauteur d'eau au-dessus d'eux, et en déduisent l'absorption de
 *    Beer-Lambert et les caustiques. Sans ça, un corail rose posé sous deux
 *    mètres d'eau reste rose vif et l'illusion de profondeur s'effondre. Leur
 *    ondulation est LENTE et ample, celle d'un végétal porté par l'eau — c'est
 *    ce contraste de rythme avec le vent qui fait lire « sous l'eau ».
 *
 * Les objets suivent le terrain : si on creuse dessous, ils descendent. Un
 * drapeau resté suspendu en l'air après un effondrement casserait tout.
 */

import * as THREE from 'three';
import {
  NX, NZ, VOXEL, WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z, clamp,
} from '../core/Config.js';
import {
  mulberry, makeSeagrass, makeAlgae, makeBranchCoral, makeBrainCoral,
  makeTableCoral, makeSeaFan, makeSeaRock, makeUrchin,
} from './SeaLifeGeometry.js';
// `mergeGeoms` vivait ici en double. Il est desormais partage avec
// ToolGeometry.js : props et outils appartiennent au meme monde, ils peuvent
// bien partager une fusion de BufferGeometry.
import { mergeGeoms } from './GeoUtils.js';
import { TOY } from './ToolGeometry.js';

/**
 * Catalogue. `under` marque ce qui vit sous l'eau, `sway` l'amplitude de
 * l'ondulation (0 = rigide), `wind` le rythme saccadé de l'air.
 */
const KINDS = [
  // Le rouge et le bleu sont ceux du bac a jouets (ToolGeometry.TOY) : un bac
  // reel a trois ou quatre couleurs qui reviennent, et c'est precisement ce
  // qui fait qu'il ressemble a un ensemble et non a un inventaire.
  { id: 'flagRed', color: TOY.red, kind: 'flag', max: 60, sway: 0 },
  { id: 'flagBlue', color: TOY.blue, kind: 'flag', max: 60, sway: 0 },
  { id: 'shell', color: 0xdfcdb4, kind: 'shell', max: 600, sway: 0 },
  { id: 'starfish', color: 0xe8823f, kind: 'star', max: 140, sway: 0 },
  { id: 'grass', color: 0x93a457, kind: 'grass', max: 900, sway: 0.5, wind: true },
  { id: 'pebble', color: 0x9a9186, kind: 'pebble', max: 600, sway: 0 },
  // --- sous l'eau ---------------------------------------------------------
  { id: 'seagrass', color: 0x3d6b3c, kind: 'seagrass', max: 2400, sway: 1.0, under: true },
  { id: 'algae', color: 0x59762f, kind: 'algae', max: 800, sway: 1.2, under: true },
  { id: 'coral', color: 0xe08a8a, kind: 'coralBranch', max: 260, sway: 0.12, under: true },
  { id: 'brain', color: 0xd9a05b, kind: 'brainCoral', max: 100, sway: 0, under: true },
  { id: 'table', color: 0xc98b6a, kind: 'tableCoral', max: 90, sway: 0.05, under: true },
  { id: 'fan', color: 0xd4707f, kind: 'seaFan', max: 90, sway: 0.8, under: true },
  { id: 'seaRock', color: 0x7e7a70, kind: 'seaRock', max: 110, sway: 0, under: true },
  { id: 'urchin', color: 0x4a3f52, kind: 'urchin', max: 100, sway: 0, under: true },
];

const F = (v) => v.toFixed(5);

// ---------------------------------------------------------------------------
// GEOMETRIES DE SURFACE
// ---------------------------------------------------------------------------

function makeFlagGeometry() {
  const pole = new THREE.CylinderGeometry(0.004, 0.005, 0.22, 6, 1);
  pole.translate(0, 0.11, 0);
  const cloth = new THREE.BufferGeometry();
  const v = new Float32Array([
    0.004, 0.215, 0, 0.004, 0.16, 0, 0.075, 0.192, 0.012,
    0.004, 0.215, 0, 0.075, 0.192, 0.012, 0.004, 0.16, 0,
  ]);
  cloth.setAttribute('position', new THREE.BufferAttribute(v, 3));
  cloth.computeVertexNormals();
  return mergeGeoms([pole, cloth]);
}

function makeShellGeometry() {
  const g = new THREE.SphereGeometry(0.026, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const rib = 1 + 0.1 * Math.cos(a * 11);
    p.setXYZ(i, x * rib * 1.15, y * 0.42, z * rib * (0.7 + 0.3 * (r / 0.026)));
  }
  g.computeVertexNormals();
  return g;
}

function makeStarGeometry() {
  const shape = new THREE.Shape();
  const arms = 5, R = 0.05, r = 0.019;
  for (let i = 0; i < arms * 2; i++) {
    const a = (i / (arms * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.011, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005, bevelSegments: 2,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.006, 0);
  return g;
}

function makeGrassGeometry() {
  const parts = [];
  const rnd = mulberry(7);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rnd() * 0.7;
    const lean = 0.3 + rnd() * 0.3;
    const h = 0.15 + rnd() * 0.16;
    const w0 = 0.009 + rnd() * 0.004;
    const SEG = 5;
    const pos = [];
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const sx = -dirz, sz = dirx;
    const bladePoint = (t) => [dirx * lean * t * t * h * 2.6, t * h, dirz * lean * t * t * h * 2.6];
    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG;
      const p0 = bladePoint(t0), p1 = bladePoint(t1);
      const w0k = w0 * (1 - t0) ** 0.8, w1k = w0 * (1 - t1) ** 0.8;
      pos.push(
        p0[0] - sx * w0k, p0[1], p0[2] - sz * w0k,
        p0[0] + sx * w0k, p0[1], p0[2] + sz * w0k,
        p1[0] + sx * w1k, p1[1], p1[2] + sz * w1k,
        p0[0] - sx * w0k, p0[1], p0[2] - sz * w0k,
        p1[0] + sx * w1k, p1[1], p1[2] + sz * w1k,
        p1[0] - sx * w1k, p1[1], p1[2] - sz * w1k
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeGeoms(parts);
}

function makePebbleGeometry() {
  const g = new THREE.IcosahedronGeometry(0.035, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.82 + 0.36 * Math.abs(Math.sin(x * 61) * Math.cos(z * 47));
    p.setXYZ(i, x * n * 1.25, y * n * 0.6, z * n);
  }
  g.computeVertexNormals();
  g.translate(0, 0.012, 0);
  return g;
}

function geometryFor(kind) {
  switch (kind) {
    case 'flag': return makeFlagGeometry();
    case 'shell': return makeShellGeometry();
    case 'star': return makeStarGeometry();
    case 'grass': return makeGrassGeometry();
    case 'seagrass': return makeSeagrass();
    case 'algae': return makeAlgae();
    case 'coralBranch': return makeBranchCoral();
    case 'brainCoral': return makeBrainCoral();
    case 'tableCoral': return makeTableCoral();
    case 'seaFan': return makeSeaFan();
    case 'seaRock': return makeSeaRock();
    case 'urchin': return makeUrchin();
    default: return makePebbleGeometry();
  }
}

// ---------------------------------------------------------------------------
// MATERIAU
// ---------------------------------------------------------------------------

/**
 * Enrichit un MeshStandardMaterial :
 *   - ondulation (vent saccade en surface, houle lente sous l'eau) ;
 *   - variation de teinte par instance ;
 *   - pour l'immerge : absorption de Beer-Lambert et caustiques, lues dans la
 *     texture du champ d'eau.
 */
function patchMaterial(mat, opts) {
  const uniforms = {
    uTime: { value: 0 },
    uSway: { value: opts.sway || 0 },
    uWind: { value: opts.wind ? 1 : 0 },
    uUnder: { value: opts.under ? 1 : 0 },
    uField: { value: null },
    uRefractionCapture: { value: 0 },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.86) },
    uSunUp: { value: 0.8 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute float aSway;
        attribute vec3 aTint;
        uniform float uTime;
        uniform float uSway;
        uniform float uWind;
        uniform float uUnder;
        uniform sampler2D uField;
        uniform float uRefractionCapture;
        varying vec3 vTint;
        varying float vWaterDepth;
        varying vec3 vPropWorld;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vTint = aTint;

        // Position monde de l'instance : elle sert de phase (chaque touffe
        // bouge differemment) et d'adresse dans la texture du champ d'eau.
        vec3 inst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float phase = inst.x * 3.7 + inst.z * 2.9;

        if (uSway > 0.001) {
          // Sous l'eau : lent et ample. Au vent : rapide et saccade.
          float t = uTime * mix(2.6, 0.85, uUnder);
          float amp = uSway * mix(0.030, 0.055, uUnder);
          // La courbure croit avec le carre de la hauteur : le pied ne bouge
          // pas, la pointe balaie.
          float k = aSway * aSway;
          float s1 = sin(t + phase);
          float s2 = sin(t * 1.7 + phase * 1.3);
          // Le vent a des rafales : on ecrase la sinusoide vers ses extremes.
          float gust = mix(1.0, 0.6 + 0.7 * abs(s2), uWind);
          transformed.x += s1 * amp * k * gust;
          transformed.z += s2 * amp * 0.7 * k * gust;
          transformed.y -= abs(s1) * amp * 0.35 * k;
        }

        vec4 wp4 = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        vPropWorld = wp4.xyz;

        vWaterDepth = 0.0;
        if (uUnder > 0.5) {
          vec2 fuv = vec2(
            (vPropWorld.x - (${F(ORIGIN_X)})) / ${F(WORLD_W)},
            (vPropWorld.z - (${F(ORIGIN_Z)})) / ${F(WORLD_D)}
          );
          vec4 wf = texture2D(uField, clamp(fuv, 0.002, 0.998));
          // Hauteur d'eau AU-DESSUS de ce sommet.
          vWaterDepth = max(0.0, wf.r - vPropWorld.y);
        }
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform float uUnder;
        uniform float uTime;
        uniform sampler2D uField;
        uniform float uRefractionCapture;
        uniform vec3 uSunColor;
        uniform float uSunUp;
        varying vec3 vTint;
        varying float vWaterDepth;
        varying vec3 vPropWorld;

        float pr_hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float pr_noise2(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(pr_hash12(i), pr_hash12(i + vec2(1, 0)), f.x),
                     mix(pr_hash12(i + vec2(0, 1)), pr_hash12(i + vec2(1, 1)), f.x), f.y);
        }
      `)
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>
        diffuseColor.rgb *= vTint;
      `)
      .replace('#include <dithering_fragment>', /* glsl */ `
        #include <dithering_fragment>
        if (uUnder > 0.5 && vWaterDepth > 0.002) {
          float wd = vWaterDepth;
          // Absorption : le rouge part le premier, d'ou le virage au bleu-vert
          // de tout ce qui est un peu profond.
          vec3 SIGMA = vec3(2.10, 0.30, 0.20);
          vec3 trans = exp(-SIGMA * wd * 1.5);
          // Une part de la lumiere diffusee par l'eau elle-meme revient : sans
          // elle, le fond devient noir au lieu de devenir bleu.
          vec3 inscatter = vec3(0.055, 0.34, 0.40) * (1.0 - trans.g);
          if (uRefractionCapture < 0.5) {
            gl_FragColor.rgb = gl_FragColor.rgb * trans + inscatter;
          }

          // Meme concentration refractive que sur le sable : la courbure du
          // champ reconstruit depuis les billes pilote l'intensite. Le motif
          // procedural ne fait qu'en casser la regularite spatiale.
          vec2 fuv = vec2(
            (vPropWorld.x - (${ORIGIN_X.toFixed(5)})) / ${WORLD_W.toFixed(5)},
            (vPropWorld.z - (${ORIGIN_Z.toFixed(5)})) / ${WORLD_D.toFixed(5)}
          );
          vec2 texel = vec2(${(1 / NX).toFixed(8)}, ${(1 / NZ).toFixed(8)});
          vec2 fcell = (floor(clamp(fuv, 0.0, 0.99999) / texel) + 0.5) * texel;
          vec4 wc = texture2D(uField, fcell);
          vec4 wl = texture2D(uField, fcell - vec2(texel.x, 0.0));
          vec4 wr = texture2D(uField, fcell + vec2(texel.x, 0.0));
          vec4 wd0 = texture2D(uField, fcell - vec2(0.0, texel.y));
          vec4 wu = texture2D(uField, fcell + vec2(0.0, texel.y));
          float invDx2 = ${(1 / (VOXEL * VOXEL)).toFixed(1)};
          float curvX = (wl.r - 2.0 * wc.r + wr.r) * invDx2;
          float curvZ = (wd0.r - 2.0 * wc.r + wu.r) * invDx2;
          float refractSpan = min(wd, 0.9) * 0.245;
          float causticJacobian = abs((1.0 + refractSpan * curvX)
                                    * (1.0 + refractSpan * curvZ));
          float focus = clamp(1.0 / max(causticJacobian, 0.28), 0.35, 3.2);
          float wetNeighbors = step(0.002, wl.g) * step(0.002, wr.g)
                             * step(0.002, wd0.g) * step(0.002, wu.g);
          float physicalFocus = smoothstep(0.92, 2.35, focus) * wetNeighbors;
          vec2 cp = vPropWorld.xz * 11.0;
          float c1 = pr_noise2(cp + vec2(uTime * 0.35, uTime * 0.22));
          float c2 = pr_noise2(cp * 1.7 - vec2(uTime * 0.28, uTime * 0.4));
          float lace = pow(clamp(1.0 - abs(c1 - c2) * 3.4, 0.0, 1.0), 2.0);
          float caus = physicalFocus * (0.38 + 0.62 * lace);
          gl_FragColor.rgb += uSunColor * caus * exp(-wd * 1.1) * 0.30 * uSunUp;
        }
      `);
  };
  return uniforms;
}

// ---------------------------------------------------------------------------

export class Props {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/VoxelField.js').VoxelField} field
   */
  constructor(scene, field) {
    this.scene = scene;
    this.field = field;
    this.group = new THREE.Group();
    this.group.name = 'props';
    scene.add(this.group);
    this.time = 0;

    const rnd = mulberry(4242);

    this.kinds = KINDS.map((k) => {
      const geo = geometryFor(k.kind);
      if (!geo.attributes.aSway) {
        const n = geo.attributes.position.count;
        geo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n), 1));
      }
      const soft = k.kind === 'flag' || k.kind === 'grass' ||
        k.kind === 'seagrass' || k.kind === 'algae' || k.kind === 'seaFan';
      const mat = new THREE.MeshStandardMaterial({
        color: k.color,
        roughness: k.kind === 'shell' ? 0.42
          : (k.kind === 'pebble' || k.kind === 'seaRock') ? 0.88 : 0.74,
        metalness: 0,
        side: soft ? THREE.DoubleSide : THREE.FrontSide,
      });
      const uniforms = patchMaterial(mat, k);

      const max = k.max || 300;
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.count = 0;
      // Les ombres de l'herbier coutent cher et ne se voient pas sous l'eau.
      mesh.castShadow = !k.under && k.kind !== 'grass';
      mesh.receiveShadow = !k.under;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      // Teinte par instance : sans elle, mille exemplaires du meme corail se
      // lisent immediatement comme du copier-coller.
      const tint = new Float32Array(max * 3);
      for (let i = 0; i < max; i++) {
        const v = 0.84 + rnd() * 0.32;
        tint[i * 3] = v * (0.92 + rnd() * 0.16);
        tint[i * 3 + 1] = v * (0.94 + rnd() * 0.12);
        tint[i * 3 + 2] = v * (0.90 + rnd() * 0.20);
      }
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));

      this.group.add(mesh);
      return { ...k, mesh, uniforms, items: [], max };
    });

    this.byId = Object.fromEntries(this.kinds.map((k, i) => [k.id, i]));

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.settleCursor = 0;
  }

  /** Branche la texture du champ d'eau sur les materiaux immerges. */
  setWaterField(texture) {
    for (const k of this.kinds) {
      if (k.under) k.uniforms.uField.value = texture;
    }
  }

  /** Depose les objets generes avec la plage. */
  seed(scatter) {
    if (!scatter) return;
    const put = (id, list) => {
      const i = this.byId[id];
      if (i === undefined || !list) return;
      for (const p of list) this.add(i, p.x, p.y, p.z, p.r, p.s);
    };
    put('shell', scatter.shells);
    put('starfish', scatter.starfish);
    put('grass', scatter.grass);
    put('pebble', scatter.pebbles);
    put('seagrass', scatter.seagrass);
    put('algae', scatter.algae);
    put('coral', scatter.coral);
    put('brain', scatter.brain);
    put('table', scatter.table);
    put('fan', scatter.fan);
    put('seaRock', scatter.seaRocks);
    put('urchin', scatter.urchins);
    this.refreshAll();
  }

  add(kindIndex, x, y, z, rot = 0, scale = 1) {
    const k = this.kinds[kindIndex];
    if (!k || k.items.length >= k.max) return null;
    const item = { x, y, z, rot, scale, tilt: 0 };
    k.items.push(item);
    return item;
  }

  /** Pose un objet en le collant a la surface. */
  place(kindIndex, x, y, z, normal) {
    const surf = this.field.surfaceHeightAt(x, z);
    const k = this.kinds[kindIndex];
    if (!k) return;
    for (const it of k.items) {
      if (Math.abs(it.x - x) < 0.05 && Math.abs(it.z - z) < 0.05) return;
    }
    const item = this.add(kindIndex, x, Math.max(y, surf) - 0.005, z,
      Math.random() * Math.PI * 2, 0.85 + Math.random() * 0.35);
    if (item && normal && k.kind !== 'flag' && k.kind !== 'grass') {
      item.tilt = Math.min(0.5, Math.acos(clamp(normal.y, -1, 1)));
      item.nx = normal.x; item.nz = normal.z;
    }
    this.refresh(kindIndex);
  }

  removeNear(x, y, z, radius) {
    let removed = 0;
    for (let ki = 0; ki < this.kinds.length; ki++) {
      const k = this.kinds[ki];
      const before = k.items.length;
      k.items = k.items.filter((it) => Math.hypot(it.x - x, it.y - y, it.z - z) > radius);
      if (k.items.length !== before) { removed += before - k.items.length; this.refresh(ki); }
    }
    return removed;
  }

  refresh(kindIndex) {
    const k = this.kinds[kindIndex];
    const m = this._m, q = this._q, p = this._p, s = this._s;
    for (let i = 0; i < k.items.length; i++) {
      const it = k.items[i];
      p.set(it.x, it.y, it.z);
      if (it.tilt) {
        this._axis.set(it.nz || 0, 0, -(it.nx || 0));
        if (this._axis.lengthSq() < 0.01) this._axis.set(1, 0, 0);
        this._axis.normalize();
        q.setFromAxisAngle(this._axis, it.tilt);
        this._q2.setFromAxisAngle(this._up, it.rot);
        q.multiply(this._q2);
      } else {
        q.setFromAxisAngle(this._up, it.rot);
      }
      s.setScalar(it.scale);
      m.compose(p, q, s);
      k.mesh.setMatrixAt(i, m);
    }
    k.mesh.count = k.items.length;
    k.mesh.instanceMatrix.needsUpdate = true;
    // PERF : pas de computeBoundingSphere() ici. Les meshes sont en
    // frustumCulled = false et rien ne les raycaste : recalculer une sphere
    // sur 2 400 instances a chaque tassement etait du travail pur et perdu.
  }

  refreshAll() {
    for (let i = 0; i < this.kinds.length; i++) this.refresh(i);
  }

  /**
   * Les objets suivent le terrain. On n'en verifie qu'une tranche par frame :
   * un objet met au pire une demi-seconde a retomber, ce qui est invisible.
   */
  update(dt, sunColor, sunUp) {
    this.time += dt;
    const F2 = this.field;
    for (let ki = 0; ki < this.kinds.length; ki++) {
      const k = this.kinds[ki];
      k.uniforms.uTime.value = this.time;
      if (sunColor) k.uniforms.uSunColor.value.copy(sunColor);
      if (sunUp !== undefined) k.uniforms.uSunUp.value = Math.max(0, sunUp);
      if (k.items.length === 0) continue;
      let dirty = false;
      const stride = 6;
      for (let i = (this.settleCursor % stride); i < k.items.length; i += stride) {
        const it = k.items[i];
        const surf = F2.surfaceHeightAt(it.x, it.z) - 0.005;
        const d = surf - it.y;
        if (d < -0.004) { it.y += Math.max(d, -2.5 * dt); dirty = true; }
        else if (d > 0.02) { it.y += Math.min(d, 0.6 * dt); dirty = true; }
      }
      if (dirty) this.refresh(ki);
    }
    this.settleCursor++;
  }

  get count() {
    return this.kinds.reduce((a, k) => a + k.items.length, 0);
  }

  serialize() {
    return this.kinds.map((k) => k.items.map((it) => [
      +it.x.toFixed(3), +it.y.toFixed(3), +it.z.toFixed(3),
      +it.rot.toFixed(2), +it.scale.toFixed(2),
    ]));
  }

  deserialize(data) {
    if (!Array.isArray(data)) return;
    for (let ki = 0; ki < this.kinds.length && ki < data.length; ki++) {
      this.kinds[ki].items = (data[ki] || []).map(([x, y, z, rot, scale]) =>
        ({ x, y, z, rot, scale, tilt: 0 }));
    }
    this.refreshAll();
  }

  dispose() {
    for (const k of this.kinds) {
      k.mesh.geometry.dispose();
      k.mesh.material.dispose();
    }
    this.scene.remove(this.group);
  }
}
