/**
 * Regressions du champ GPU de l'eau, sans navigateur ni contexte WebGL.
 *
 * Le maillage est deforme par R (niveau) puis masque par G (profondeur). Si R
 * rejoint le terrain pendant que G est encore visible, une cellule seche se
 * transforme en aiguille verticale sur le sable.
 */
import * as THREE from 'three';
import { NX, NZ, WATER_EPSILON } from '../src/core/Config.js';
import { WaterRenderer } from '../src/render/WaterRenderer.js';
import { createSandMaterial } from '../src/render/SandMaterial.js';
import { Props } from '../src/render/Props.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Water } from '../src/sim/Water.js';
import { EditContext, stampBucket } from '../src/tools/Brush.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const count = NX * NZ;
const h = new Float32Array(count);
const water = {
  h,
  vx: new Float32Array(count),
  vz: new Float32Array(count),
  foam: new Float32Array(count),
  foamDry: new Float32Array(count),
  sed: new Float32Array(count),
  seaLevel: 1.05,
  droplets: {
    count: 2,
    x: new Float32Array([0, 0.12]),
    y: new Float32Array([1, 1]),
    z: new Float32Array([0, 0]),
    vis: new Float32Array([1, 0]),
    foam: new Float32Array([0.5, 0]),
    revision: 1,
  },
};
const field = { surfaceH: new Float32Array(count) };
field.surfaceH.fill(3.0); // paroi haute : rend le bug tres visible

const renderer = new WaterRenderer(new THREE.Scene(), water, field);
const c = (NX >> 1) + NX * (NZ >> 1);

console.log('\n== Champ de rendu de l eau ==');

check('les sommets d eau lisent une colonne exacte, sans melange diagonal',
  renderer.material.vertexShader.includes('floor(uvw / uTexel)'));
check('le shader reconstruit une eau refractive avec un IOR physique',
  renderer.material.fragmentShader.includes('refract(-V, N, 0.7502)'));
check('la geometrie shader ne rajoute aucune vague absente des billes',
  !renderer.material.vertexShader.includes('level += sw') &&
  !renderer.material.vertexShader.includes('sin(position.x'));
check('la refraction devie la vraie image du decor',
  renderer.material.fragmentShader.includes('uniform sampler2D uSceneColor') &&
  renderer.material.fragmentShader.includes('screenUv + refractOffset') &&
  renderer.material.fragmentShader.includes('sceneThroughWater * pathTrans'));
check('la refraction rejette les objets situes devant la surface',
  renderer.material.fragmentShader.includes('uniform sampler2D uSceneDepth') &&
  renderer.material.fragmentShader.includes('behindSurface') &&
  renderer.refractionTarget.depthTexture?.isDepthTexture === true);
check('la qualite elevee reflete les silhouettes depuis la meme capture',
  renderer.material.fragmentShader.includes('traceScreenReflection') &&
  renderer.material.fragmentShader.includes('sceneDepthToViewZ'));
renderer.setRefractionQuality(2);
renderer.resize(3840, 2160, 2);
check('la capture refractive reste plafonnee sur un ecran 4K',
  renderer.refractionTarget.width * renderer.refractionTarget.height <= 1_350_000 &&
  renderer.refractionTarget.depthTexture.image.width === renderer.refractionTarget.width &&
  renderer.refractionTarget.depthTexture.image.height === renderer.refractionTarget.height &&
  renderer.uniforms.uRefractionEnabled.value === 1 &&
  renderer.uniforms.uScreenReflections.value === 1,
  `${renderer.refractionTarget.width}x${renderer.refractionTarget.height}`);
renderer.setRefractionQuality(0);
renderer.resize(1920, 1080, 2);
check('la qualite basse coupe la passe refractive supplementaire',
  renderer.uniforms.uRefractionEnabled.value === 0 &&
  renderer.uniforms.uScreenReflections.value === 0 &&
  renderer.refractionTarget.width === 1 && renderer.refractionTarget.height === 1);
{
  let target = { id: 'main' };
  let captures = 0;
  let waterWasHidden = true;
  let captureMaterialWasRaw = true;
  const captureFlag = { value: 0 };
  renderer.registerRefractionCaptureUniform(captureFlag);
  const fakeRenderer = {
    xr: { enabled: true },
    getRenderTarget: () => target,
    setRenderTarget: (v) => { target = v; },
    clear() {},
    render() {
      captures++;
      waterWasHidden = waterWasHidden && !renderer.mesh.visible &&
        !renderer.volume.mesh.visible && !renderer.droplets.visible;
      captureMaterialWasRaw = captureMaterialWasRaw && captureFlag.value === 1;
    },
  };
  renderer.setRefractionQuality(1);
  renderer.resize(1280, 720, 1);
  renderer._refractionFrame = 0;
  renderer._hasRefractionFrame = false;
  const fakeCamera = { projectionMatrix: new THREE.Matrix4(), near: 0.05, far: 120 };
  renderer.captureRefraction(fakeRenderer, fakeCamera);
  renderer.captureRefraction(fakeRenderer, fakeCamera);
  renderer.captureRefraction(fakeRenderer, fakeCamera);
  check('la qualite moyenne capture une frame sur deux et restaure la scene',
    captures === 2 && waterWasHidden && captureMaterialWasRaw && captureFlag.value === 0 &&
    target.id === 'main' &&
    fakeRenderer.xr.enabled && renderer.mesh.visible && renderer.volume.mesh.visible
    && renderer.droplets.visible,
    `${captures} capture(s) sur 3`);
}
renderer.update(1 / 60);
const dropVersion = renderer._dropPos.version;
renderer.update(1 / 60);
check('les gouttes ne sont pas rechargees entre deux pas physiques',
  renderer._dropPos.version === dropVersion);
water.droplets.revision++;
renderer.update(1 / 60);
check('les gouttes en vol sont dessinees comme des spheres lissees',
  renderer._dropPos.version > dropVersion && renderer.droplets.visible
  && renderer.droplets.geometry.instanceCount === 1
  && renderer.droplets.material.vertexShader.includes('aVis'),
  `${renderer.droplets.geometry.instanceCount} goutte(s) visible(s) sur 2`);
check('la surface lit une flow map pour faire defiler l ecume et le grain',
  renderer.material.fragmentShader.includes('uFlow')
  && renderer.material.fragmentShader.includes('adv2')
  && renderer.flowTex.image.width === NX);
check('la jupe du diorama montre le volume d eau par la tranche',
  renderer.volume.mesh.visible === true
  && renderer.volume.material.fragmentShader.includes('uSceneDepth')
  && renderer.volume.material.fragmentShader.includes('sceneDepthToViewZ'));
check('l ecume est une dentelle partagee entre l eau et le sable',
  renderer.material.fragmentShader.includes('wc_foamLace'));
check('la surface compose transmission et reflet par un Fresnel de Schlick',
  renderer.material.fragmentShader.includes('pow(1.0 - ndv, 5.0)'));
{
  // Une cellule seche porte la laisse d'ecume dans le canal B.
  const dryC = c + 3;
  h[dryC] = 0;
  water.foamDry[dryC] = 0.6;
  renderer._primed = false;
  renderer.update(1 / 60);
  check('la laisse d ecume d une cellule seche est exposee au shader du sable',
    Math.abs(renderer.data[dryC * 4 + 2] - 0.6) < 1e-6,
    `canal B = ${renderer.data[dryC * 4 + 2].toFixed(3)}`);
  water.foamDry[dryC] = 0;
  renderer._primed = false;
  renderer.update(1 / 60);
}

// Le sable doit lui aussi lire la colonne exacte sous son fragment. Sinon le
// filtre bilineaire cree une fausse demi-colonne sur la face verticale voisine
// et le seuil d'immersion suit les triangles du terrain.
{
  const sand = createSandMaterial();
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <aomap_fragment>\n#include <dithering_fragment>',
  };
  sand.onBeforeCompile(shader);
  check('le sable echantillonne l eau sans interpolation mouille-sec',
    shader.fragmentShader.includes('floor(fuv * waterGrid)'));
  check('une paroi verticale ne prend plus la teinte cyan complete de l eau',
    shader.fragmentShader.includes('mix(1.0, 0.10, faceGate)'));
  check('les caustiques du sable dependent de la courbure des billes',
    shader.fragmentShader.includes('causticJacobian') &&
    shader.fragmentShader.includes('physicalFocus'));
  check('la capture du fond ne double pas l absorption du sable',
    shader.fragmentShader.includes('uniform float uRefractionCapture') &&
    shader.fragmentShader.includes('if (uRefractionCapture < 0.5)'));
  sand.dispose();
}

// Meme porte sur les algues, coraux et galets immerges : tous sont presents
// dans la capture refractive et ne doivent pas etre absorbes deux fois.
{
  const propScene = new THREE.Scene();
  const props = new Props(propScene, {});
  const under = props.kinds.find((kind) => kind.under);
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <dithering_fragment>',
  };
  under.mesh.material.onBeforeCompile(shader);
  check('la capture du fond ne double pas l absorption des objets immerges',
    shader.fragmentShader.includes('uniform float uRefractionCapture') &&
    shader.fragmentShader.includes('if (uRefractionCapture < 0.5)'));
  props.dispose();
}

// La cellule commence mouillee a 1 m, puis seche devant une paroi de 3 m.
field.surfaceH[c] = 0.90;
h[c] = 0.10;
renderer.update(1 / 60);
const wetLevel = renderer.data[c * 4];

h[c] = 0;
field.surfaceH[c] = 3.0;
renderer.update(1 / 60);
const dryingLevel = renderer.data[c * 4];
const dryingDepth = renderer.data[c * 4 + 1];
check('une cellule qui seche garde son niveau tant qu elle reste visible',
  dryingDepth > 0.0016 && Math.abs(dryingLevel - wetLevel) < 1e-6,
  `niveau ${wetLevel.toFixed(3)} -> ${dryingLevel.toFixed(3)}, profondeur ${dryingDepth.toFixed(4)}`);

// Une cellule invisible qui se remouille dans une fosse doit prendre son
// nouveau niveau avant que sa profondeur lissee ne la fasse apparaitre.
for (let i = 0; i < 60; i++) renderer.update(1 / 60);
field.surfaceH[c] = 0.60;
h[c] = 0.10;
renderer.update(1 / 60);
const rewetLevel = renderer.data[c * 4];
const rewetDepth = renderer.data[c * 4 + 1];
check('une cellule remouillee est calee avant de redevenir visible',
  rewetDepth > 0.0016 && Math.abs(rewetLevel - 0.70) < 1e-5,
  `niveau ${rewetLevel.toFixed(3)}, profondeur ${rewetDepth.toFixed(4)}`);

renderer.dispose();

console.log('\n== Construction dans l eau ==');
{
  const wetField = new VoxelField();
  // Fond horizontal a six voxels, suffisant pour poser une tour au centre.
  for (let y = 0; y < 6; y++) {
    for (let z = 0; z < NZ; z++) {
      const row = NX * (z + NZ * y);
      wetField.density.fill(255, row, row + NX);
      wetField.material.fill(1, row, row + NX);
    }
  }
  wetField.rebuildAll();

  const wetGranular = new Granular(wetField);
  const wetMoisture = { touchBox() {} };
  const wetWater = new Water(wetField, wetGranular, wetMoisture);
  wetWater.setSeaState(0);
  wetWater.tideSpeed = 0;
  const center = (NX >> 1) + NX * (NZ >> 1);
  const oldLevel = wetField.surfaceH[center] + 0.45;
  // Une mer plate a 45 cm sur tout le fond, reliee au large.
  wetWater.seaLevel = oldLevel;
  wetWater.tideLevel = oldLevel;
  wetWater.waveSetup = 0;
  wetWater.initialize();
  const before = wetWater.totalVolume();
  const ctx = new EditContext(wetField, wetGranular, wetMoisture, wetWater, null);

  stampBucket(ctx, 0, wetField.surfaceH[center], 0,
    0.24, 0.20, 0.52, 0.14, 0.90, 0.98);

  let overshoot = 0;
  for (let z = (NZ >> 1) - 9; z <= (NZ >> 1) + 9; z++) {
    for (let x = (NX >> 1) - 9; x <= (NX >> 1) + 9; x++) {
      const c2 = x + NX * z;
      if (wetWater.h[c2] <= WATER_EPSILON) continue;
      overshoot = Math.max(overshoot, wetField.surfaceH[c2] + wetWater.h[c2] - oldLevel);
    }
  }
  check('la tour chasse l eau de son volume au lieu de la hisser',
    wetWater.h[center] <= WATER_EPSILON,
    `profondeur centrale ${wetWater.h[center].toFixed(4)} m`);
  check('la surface libre ne monte pas le long de la tour', overshoot < 1e-5,
    `depassement ${(overshoot * 100).toFixed(3)} cm`);
  check('l eau chassee par la tour est rendue a la mer', wetWater.totalVolume() < before - 0.004,
    `${((before - wetWater.totalVolume()) * 1000).toFixed(1)} L chasses`);
}

console.log(failures === 0 ? '\nTous les tests de rendu eau passent.\n' :
  `\n${failures} test(s) de rendu eau en echec.\n`);
process.exit(failures ? 1 : 0);
