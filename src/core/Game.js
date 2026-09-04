/**
 * Game — assemblage et boucle principale.
 *
 * Ordre d'une frame :
 *   1. entrees, outils, camera
 *   2. horloge (heure du jour, maree)
 *   3. simulation a pas fixe : granulaire -> humidite -> eau/erosion
 *   4. collecte des chunks sales -> pool de maillage
 *   5. rendu
 */

import * as THREE from 'three';
import {
  SIM_DT, SIM_MAX_STEPS, DAY_LENGTH, BUDGET_REMESH, BUDGET_GRANULAR, VOXEL, ORIGIN_X, ORIGIN_Z, NX, NZ, normalizeMapSize, setPendingMapSize,
} from './Config.js';
import { VoxelField } from '../sim/VoxelField.js';
import { Granular } from '../sim/Granular.js';
import { Moisture } from '../sim/Moisture.js';
import { Water } from '../sim/Water.js';
import { Weather } from './Weather.js';
import { MesherPool } from '../sim/meshing/MesherPool.js';
import { generateBeach, BEACH_STYLES, beachParamsOf } from '../world/BeachGenerator.js';
import { createSandMaterial } from '../render/SandMaterial.js';
import { TerrainRenderer } from '../render/TerrainRenderer.js';
import { WaterRenderer } from '../render/WaterRenderer.js';
import { Props } from '../render/Props.js';
// --- OUTILS 3D VISIBLES (debut) -------------------------------------------
import { SandParticles } from '../render/SandParticles.js';
import { ToolAvatar } from '../render/ToolAvatar.js';
import { DroppedTools } from '../render/DroppedTools.js';
// --- OUTILS 3D VISIBLES (fin) ---------------------------------------------
import { Sky } from '../render/Sky.js';
import { DioramaControls } from '../render/DioramaControls.js';
import { Post } from '../render/Post.js';
import { ToolManager } from '../tools/ToolManager.js';
import { Audio } from '../audio/Audio.js';
import { HUD } from '../ui/HUD.js';
import { SaveManager } from './Save.js';

const PENDING_BEACH_KEY = 'sc.pendingBeach';
function readPendingBeach() {
  try {
    const raw = localStorage.getItem(PENDING_BEACH_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_BEACH_KEY);
    const o = JSON.parse(raw);
    return o && o.params ? o : null;
  } catch { return null; }
}
function writePendingBeach(o) {
  try { localStorage.setItem(PENDING_BEACH_KEY, JSON.stringify(o)); } catch {}
}
import { WaterGPU } from '../sim/WaterGPU.js';

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, onProgress = () => {}) {
    this.canvas = canvas;
    this.onProgress = onProgress;
    this.time = 0;
    this.dayT = 0.36;
    this.paused = false;
    this.photoMode = false;
    this.accumulator = 0;
    this.stats = {
      fps: 0, sim: 0, triangles: 0, meshQueue: 0,
      activeVoxels: 0, wetCells: 0, tide: 0,
    };
    this._frames = 0;
    this._fpsTimer = 0;
    this._tmpVec = new THREE.Vector3();
    // --- PERF (instrumentation, debut) --------------------------------------
    // Accumulateurs de millisecondes CPU par sous-systeme, remis a zero par
    // perfReset(). Lus par les outils de profilage (tools/profile-perf.mjs).
    this.perf = {
      frames: 0, controls: 0, tools: 0, tools3d: 0, gran: 0, moist: 0,
      water: 0, props: 0, mesh: 0, waterTex: 0, render: 0, hud: 0, total: 0,
    };
    // --- PERF (instrumentation, fin) ----------------------------------------

    /** Sable transporte a la pelle. */
    this.carried = { volume: 0, moisture: 0.1, packing: 0.3 };
    /** Messages a distiller au demarrage. */
    this.toastQueue = [];
    this.toastTimer = 1.6;
    this._tideWarned = -1;
    /** Fraction du budget de simulation utilisee (adaptatif). */
    this.simBudget = 1;
    /** Niveau de qualite : 0 = bas, 1 = moyen, 2 = eleve. */
    this.quality = 2;
    this._qualityProbe = 0;
  }

  async init() {
    this.onProgress(0.04, 'Initialisation du moteur…');

    // --- renderer -----------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposition basse : avec un soleil a 5,0, c'est elle qui garde de la
    // matiere dans le sable blanc au lieu de le cramer.
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.shadowMap.enabled = true;
    // Penombre douce : la lumiere du soleil sur une plage n'a jamais un bord
    // d'ombre dur a 2 mm, et c'est ce qui trahissait le rendu de synthese.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // --- scene / camera -----------------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 120);
    this.camera.position.set(7, 6, 7);

    this.sky = new Sky(this.scene, this.renderer);
    this.controls = new DioramaControls(this.camera, this.canvas);
    // Vue d'ouverture : depuis le haut de plage, la mer en face et l'horizon
    // derriere elle. La plage occupe le premier plan, le large ferme le cadre.
    this.controls.azimuth = this.controls.goalAzimuth = Math.PI * 0.90;
    this.controls.polar = this.controls.goalPolar = 1.02;
    this.controls.focus(0.2, 1.25, 1.2, 17.0 * Math.max(NX, NZ) / 320);

    // --- terrain ------------------------------------------------------------
    this.onProgress(0.14, 'Modelage de la plage…');
    await frame();
    this.field = new VoxelField();
    // Une plage commandee avant un rechargement (changement de taille) : on
    // la genere maintenant et on ne reprend pas la sauvegarde.
    this.pendingBeach = readPendingBeach();
    this.beach = this.pendingBeach
      ? generateBeach(this.field, this.pendingBeach.seed, this.pendingBeach.params)
      : generateBeach(this.field);
    /** Style, parametres et graine de la plage courante : affiches et sauvegardes. */
    this.beachInfo = { style: this.beach.style, params: beachParamsOf(this.beach.style === 'custom' ? this.pendingBeach.params : this.beach.style), seed: this.beach.seed };

    this.onProgress(0.4, 'Preparation du sable…');
    await frame();

    this.sandMaterial = createSandMaterial();
    this.terrain = new TerrainRenderer(this.scene, this.sandMaterial);
    this.mesher = new MesherPool(this.field, (ci, geo) => this.terrain.update(ci, geo));

    // --- simulation ---------------------------------------------------------
    this.granular = new Granular(this.field);
    this.moisture = new Moisture(this.field, this.granular);
    this.water = new Water(this.field, this.granular, this.moisture);
    // Solveur d'eau sur GPU (WebGL2). Il se valide contre le CPU pendant ses
    // premiers pas et se retire au moindre ecart. `?gpuwater=0` le coupe,
    // `?gpuwater=trace` journalise la validation.
    const gpuFlag = new URLSearchParams(location.search).get('gpuwater');
    if (gpuFlag !== '0') {
      try {
        this.water.attachGPU(new WaterGPU(this.water, this.renderer, { trace: gpuFlag === 'trace' }));
      } catch (e) {
        console.warn('Eau GPU indisponible, solveur CPU :', e.message);
      }
    }
    this.waterRenderer = new WaterRenderer(this.scene, this.water, this.field, this.renderer);
    this.waterRenderer.fieldHz = 30;
    this.waterRenderer.registerRefractionCaptureUniform(
      this.sandMaterial.userData.uniforms.uRefractionCapture
    );

    this.onProgress(0.5, 'Montee de la maree…');
    await frame();
    // La mer au repos : remplie d'un coup jusqu'au niveau de maree.
    this.water.initialize();

    // --- decor --------------------------------------------------------------
    this.props = new Props(this.scene, this.field);
    // Les objets immerges ont besoin du champ d'eau pour connaitre la hauteur
    // d'eau au-dessus d'eux : c'est ce qui leur donne l'absorption et les
    // caustiques.
    this.props.setWaterField(this.waterRenderer.tex);
    for (const kind of this.props.kinds) {
      this.waterRenderer.registerRefractionCaptureUniform(kind.uniforms.uRefractionCapture);
    }
    this.sandMaterial.userData.uniforms.uField.value = this.waterRenderer.tex;
    this.props.seed(this.beach.scatterPoints);

    // --- OUTILS 3D VISIBLES (debut) ----------------------------------------
    // Un seul systeme de particules pour tout le jeu : grains, poussiere,
    // gouttes. Un draw call, 3 000 particules, ~0,05 ms de CPU.
    this.particles = new SandParticles(this.scene, this.field, 3000);
    // Une goutte d'arrosoir sur huit mouille vraiment le sable : le retour
    // visuel precede la consequence physique.
    this.particles._wet = (x, y, z) => this.moisture.wetSphere(x, y, z, 0.05, 0.010);
    // Les embruns du rouleau sont des particules du meme systeme.
    this.water.onSpray = (x, y, z, vx, vy, vz) => this.particles.spawn(5, x, y, z, vx, vy, vz);
    // La meteo : mer, vent, ciel et pluie d'un seul geste.
    this.weather = new Weather(this);
    this.weather.apply(2);
    // --- OUTILS 3D VISIBLES (fin) ------------------------------------------

    this.onProgress(0.58, 'Extraction de la surface…');
    await this.warmupMeshing();

    // --- post-traitement ----------------------------------------------------
    this.onProgress(0.92, 'Reglage de la lumiere…');
    this.post = new Post(this.renderer, this.scene, this.camera);
    await frame();

    // --- interaction --------------------------------------------------------
    this.tools = new ToolManager(this);
    // La camera a besoin de savoir ce qu'il y a sous le curseur pour y ancrer
    // son zoom.
    this.controls.resolveAnchor = (nx, ny) => this.pickWorldPoint(nx, ny);
    this.audio = new Audio();
    this.save = new SaveManager(this);
    // Reglage persistant : sculpter sans craindre la mer.
    let safe = false;
    try { safe = localStorage.getItem('sc.sandSafe') === '1'; } catch {}
    this.setSandSafe(safe);
    this.hud = new HUD(this, document.getElementById('hud'));

    // --- OUTILS 3D VISIBLES (debut) ----------------------------------------
    this.toolAvatar = new ToolAvatar(this);
    this.droppedTools = new DroppedTools(this, (id, st) => this.toolAvatar.makeDropped(id, st));
    this.toolAvatar.select(this.tools.current.id);
    this.onToolChanged = (t) => {
      this.hud.setActiveTool(t);
      this.toolAvatar.select(t.id);
    };
    // --- OUTILS 3D VISIBLES (fin) ------------------------------------------

    this.hud.setActiveTool(this.tools.current);

    // L'audio ne peut demarrer qu'apres un geste de l'utilisateur.
    const startAudio = () => {
      this.audio.resume();
      window.removeEventListener('pointerdown', startAudio);
      window.removeEventListener('keydown', startAudio);
    };
    window.addEventListener('pointerdown', startAudio);
    window.addEventListener('keydown', startAudio);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyP') this.togglePhotoMode();
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        this.saveNow();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
        e.preventDefault();
        this.loadLast();
      }
    });

    // Reprise automatique de la derniere partie. `?fresh=1` la court-circuite :
    // c'est ce qu'utilisent les tests automatises, qui ont besoin d'une plage
    // identique a chaque lancement.
    const fresh = new URLSearchParams(location.search).has('fresh');
    if (this.pendingBeach) {
      const name = BEACH_STYLES.find((st) => st.id === this.beachInfo.style)?.name || 'Plage personnalisee';
      this.toastQueue.push(`${name} — ${NX * VOXEL} m x ${NZ * VOXEL} m, graine ${this.beachInfo.seed}`);
      this.pendingBeach = null;
    } else if (!fresh) {
      try {
        const resumed = await this.save.load('latest');
        if (resumed) this.toastQueue.push('Partie precedente rechargee');
      } catch (err) {
        console.warn('Reprise impossible :', err.message);
      }
    }
    this.queueOnboarding(fresh);

    addEventListener('resize', () => this.resize());
    this.resize();
    this.sky.update(this.dayT, true);
    this.onProgress(1, 'Pret !');
  }

  /** Maille tout le terrain avant le premier affichage. */
  async warmupMeshing() {
    this.mesher.collect(4096);
    let guard = 0;
    let total = 1;
    while (this.mesher.busy > 0 && guard++ < 4000) {
      // Plus aucun worker ne se charge : mieux vaut une erreur lisible
      // qu'une barre figee (voir SPAWN_ATTEMPTS dans MesherPool).
      if (this.mesher.error) throw this.mesher.error;
      await frame();
      this.mesher.collect(4096);
      total = Math.max(total, this.mesher.stats.meshed + this.mesher.busy);
      const done = this.mesher.stats.meshed / total;
      this.onProgress(0.58 + 0.33 * done, 'Extraction de la surface…');
    }
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.waterRenderer?.resize(w, h, this.renderer.getPixelRatio());
    // OUTILS 3D : la taille des grains est calculee en pixels exacts.
    this.particles?.setViewport(h, this.camera.fov);
  }

  togglePhotoMode() {
    this.photoMode = !this.photoMode;
    this.hud?.setHidden(this.photoMode);
    this.controls.autoRotate = this.photoMode;
    this.post?.setPhotoMode(this.photoMode);
    if (this.tools) this.tools.enabled = !this.photoMode;
    if (!this.photoMode) this.toast('Mode photo desactive');
  }

  toast(msg) {
    if (msg) this.hud?.toast(msg);
  }

  /**
   * Point du monde sous un curseur, en coordonnees normalisees (-1..1).
   * Retombe sur un plan horizontal a la hauteur de la cible quand le rayon ne
   * touche rien : sinon le zoom perdrait son ancrage des qu'on vise le ciel.
   */
  pickWorldPoint(ndcX, ndcY) {
    this._pickV = this._pickV || new THREE.Vector2();
    this._pickRay = this._pickRay || new THREE.Raycaster();
    this._pickV.set(ndcX, ndcY);
    this._pickRay.setFromCamera(this._pickV, this.camera);
    const o = this._pickRay.ray.origin, d = this._pickRay.ray.direction;
    const hit = this.field.raycast({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, 60);
    if (hit) return hit.point;
    if (Math.abs(d.y) < 1e-4) return null;
    const t = (this.controls.target.y - o.y) / d.y;
    if (t <= 0) return null;
    return { x: o.x + d.x * t, y: this.controls.target.y, z: o.z + d.z * t };
  }

  /**
   * Trois paliers de qualite. Le poste de depense n'est pas le meme d'un
   * palier a l'autre : en haut c'est le post-traitement, au milieu la
   * resolution, en bas les ombres. On coupe donc dans cet ordre.
   */
  setQuality(level, announce = true) {
    level = Math.max(0, Math.min(2, level | 0));
    this.quality = level;
    const names = ['Qualite basse', 'Qualite moyenne', 'Qualite elevee'];

    const pr = level === 2 ? Math.min(devicePixelRatio, 2)
      : level === 1 ? Math.min(devicePixelRatio, 1.4)
      : 1;
    this.renderer.setPixelRatio(pr);

    if (this.post) {
      this.post.enabled = level >= 1;
      this.post.godRays.enabled = level >= 2;
      this.post.bloom.enabled = level >= 2;
      this.post.smaa.enabled = level >= 2;
      this.post.setSamples(level === 2 ? 4 : level === 1 ? 2 : 0);
    }

    // 4096 sur 19 m de cadrage : 4,6 mm par texel, moins qu'un creneau.
    const shadowSize = level === 2 ? 4096 : level === 1 ? 2048 : 1024;
    const sh = this.sky.sun.shadow;
    if (sh.mapSize.width !== shadowSize) {
      sh.mapSize.set(shadowSize, shadowSize);
      sh.map?.dispose();
      sh.map = null;
    }
    this.renderer.shadowMap.enabled = level >= 1;

    // La grosse aiguille : le materiau du sable coute cher en bruit procedural.
    const u = this.sandMaterial.userData.uniforms;
    u.uSparkle.value = level >= 2 ? 1 : level === 1 ? 0.5 : 0;
    this.waterRenderer?.setRefractionQuality(level);

    this.resize();
    try { localStorage.setItem('sc.quality', String(level)); } catch {}
    if (announce) this.toast(names[level]);
  }

  /**
   * Choisit un palier au lancement en mesurant reellement la machine, plutot
   * qu'en interrogeant le materiel — qui ment.
   */
  autoQuality(dt) {
    if (this._qualityProbe < 0) return;
    this._qualityProbe += dt;
    if (this._qualityProbe < 6) return;
    this._qualityProbe = -1;
    let stored = null;
    try { stored = localStorage.getItem('sc.quality'); } catch {}
    if (stored !== null) { this.setQuality(+stored, false); return; }
    const fps = this.stats.fps;
    if (fps < 22) this.setQuality(0);
    else if (fps < 42) this.setQuality(1);
  }

  async saveNow(kind = 'manual') {
    try {
      const r = await this.save.save(kind);
      this.toast(r ? `Partie sauvegardee (${r.kb.toFixed(0)} Ko)` : 'Sauvegarde en cours…');
      if (r) this.hud?.onSavesChanged?.();
    } catch (e) {
      this.toast('Sauvegarde impossible : ' + e.message);
    }
  }

  /**
   * L'eau n'emporte plus le sable : ni erosion ni sape, quel que soit le
   * niveau de la jauge du panneau Mer. Choix conserve d'une partie a l'autre.
   */
  setSandSafe(on) {
    this.sandSafe = !!on;
    this.water.setSandSafe(this.sandSafe);
    try { localStorage.setItem('sc.sandSafe', this.sandSafe ? '1' : '0'); } catch {}
    this.hud?.syncSeaPanel?.();
  }

  /**
   * Repart d'une plage vierge. L'historique est conserve (on peut y revenir) ;
   * la nouvelle plage y entre tout de suite, pour que la reprise au demarrage
   * retrouve bien celle-ci et non la precedente.
   */
  /**
   * @param {string|object|null} spec identifiant de style, ou parametres libres
   *   (avec `nx`/`nz` pour changer la taille de la carte : la page se recharge)
   */
  async newBeach(spec = null, seed = null) {
    if (!(seed >= 0)) seed = (Math.random() * 1e9) | 0;
    let params = spec && typeof spec === 'object' ? spec : null;
    if (!params) {
      const id = BEACH_STYLES.some((st) => st.id === spec) ? spec : (this.beachInfo?.style || 'classique');
      params = beachParamsOf(id);
    }
    if (params.nx || params.nz) {
      const nx = normalizeMapSize(params.nx || NX), nz = normalizeMapSize(params.nz || NZ);
      if (nx !== NX || nz !== NZ) {
        // La taille est une constante de la page : on memorise la commande
        // et on recharge. Au retour, la plage est generee avant tout.
        setPendingMapSize(nx, nz);
        writePendingBeach({ params, seed });
        this.toast('Changement de taille : rechargement…');
        setTimeout(() => location.reload(), 150);
        return;
      }
    }
    this.beach = generateBeach(this.field, seed, params);
    const style = this.beach.style;
    this.beachInfo = { style, params: beachParamsOf(params), seed };
    // Le rivage et la houle suivent le nouveau profil avant que la mer ne
    // soit remise a plat.
    this.water.rebuildShore();
    this.props.kinds.forEach((k) => { k.items.length = 0; });
    this.props.seed(this.beach.scatterPoints);
    this.water.reset();
    this.carried.volume = 0;
    this.droppedTools?.deserialize([]);   // OUTILS 3D : plage vierge, sans outils
    this.tools.undo.clear();
    this.field.markAll();
    const name = BEACH_STYLES.find((st) => st.id === style)?.name || 'Nouvelle plage';
    this.toast(`${name} — graine ${seed}`);
    if (this.save.autosaveEnabled) {
      this.save.save('auto').then(() => this.hud?.onSavesChanged?.()).catch(() => {});
    }
  }

  /** Recharge une entree de l'historique (`latest` : la plus recente). */
  async loadLast(key = 'latest') {
    try {
      const ok = await this.save.load(key);
      this.toast(ok ? 'Partie rechargee' : 'Aucune sauvegarde');
      this.hud?.onSavesChanged?.();
    } catch (e) {
      this.toast('Chargement impossible : ' + e.message);
    }
  }

  /**
   * Onboarding : pas de tutoriel bloquant, juste trois phrases distillees
   * pendant que le joueur decouvre. Le reste s'apprend en creusant.
   */
  queueOnboarding(fresh = false) {
    if (fresh) return;
    try {
      if (localStorage.getItem('sc.seen') === '1') return;
      localStorage.setItem('sc.seen', '1');
    } catch {
      return; // navigation privee : on n'insiste pas
    }
    this.toastQueue.push(
      'Clic gauche pour creuser. Clic droit pour vider la pelle.',
      'Le sable sec ne tient pas : mouille-le avec l arrosoir (3).',
      'Puis tasse-le a la main (2) : c est ce qui fait tenir les murs.',
      'H a tout moment pour l aide complete.'
    );
  }

  /** Fait avancer la file de messages et surveille la maree. */
  updateNarration(dt) {
    if (this.toastQueue.length) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) {
        this.toast(this.toastQueue.shift());
        this.toastTimer = 5.5;
      }
    }
    // Alerte de maree : une seule fois par montee, quand ca devient serieux.
    const phase = this.water.tidePhase;
    const rising = this.water.tide > this._lastTideVal;
    this._lastTideVal = this.water.tide;
    if (rising && phase > 0.72 && this._tideWarned < 0) {
      this._tideWarned = 1;
      this.toast('La maree monte. Protege ton chateau — ou regarde-le partir.');
    } else if (phase < 0.4) {
      this._tideWarned = -1;
    }
  }

  // --- PERF (instrumentation, debut) ---------------------------------------
  /** Remet a zero les accumulateurs de profilage. */
  perfReset() {
    const p = this.perf;
    for (const k in p) p[k] = 0;
  }
  // --- PERF (instrumentation, fin) -----------------------------------------

  /** @param {number} dt secondes reelles */
  update(dt) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    // PERF : jalons de mesure par sous-systeme (voir this.perf).
    const P = this.perf;
    const tF = performance.now();
    let tm = tF;

    // --- horloge -------------------------------------------------------------
    if (!this.paused) this.dayT = (this.dayT + dt / DAY_LENGTH) % 1;
    this.sky.update(this.dayT);
    const su = this.sandMaterial.userData.uniforms;
    su.uSunDirection.value.copy(this.sky.sunDir);
    su.uSunColor.value.copy(this.sky.sun.color);
    su.uTime.value = this.time;
    su.uWaterTable.value = this.water.waterTable;

    this.controls.update(dt);
    P.controls += -tm + (tm = performance.now());
    this.tools.update(dt);
    P.tools += -tm + (tm = performance.now());

    // --- OUTILS 3D VISIBLES (debut) ----------------------------------------
    this.toolAvatar?.update(dt, this.tools);
    this.droppedTools?.update(dt);
    this.particles?.update(dt);
    // --- OUTILS 3D VISIBLES (fin) ------------------------------------------
    P.tools3d += -tm + (tm = performance.now());

    // --- simulation a pas fixe ----------------------------------------------
    // Le budget granulaire s'adapte : sur une machine lente on preferera du
    // sable qui coule un peu plus lentement a un jeu qui saccade.
    if (this.stats.fps > 5) {
      const target = this.stats.fps < 40 ? 0.45 : this.stats.fps < 52 ? 0.72 : 1;
      this.simBudget += (target - this.simBudget) * 0.05;
    }
    const t0 = performance.now();
    if (!this.paused) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= SIM_DT && steps < SIM_MAX_STEPS) {
        this.step(SIM_DT);
        this.accumulator -= SIM_DT;
        steps++;
      }
      if (this.accumulator > SIM_DT * SIM_MAX_STEPS) this.accumulator = 0;
    }
    this.stats.sim = this.stats.sim * 0.9 + (performance.now() - t0) * 0.1;
    tm = performance.now(); // PERF

    // --- decor et son --------------------------------------------------------
    this.props.update(dt, this.sky.sun.color, this.sky.sunDir.y);
    P.props += -tm + (tm = performance.now()); // PERF
    this.weather?.update(dt);
    this.audio.updateAmbient(dt, this.water.swash * 10, this.moisture.wind, this.water.stats.breaking);
    if (this.granular.events.length) {
      for (const e of this.granular.events) {
        if (e.type !== 'collapse') continue;
        // Un transfert granulaire passif n'est pas un impact. Le jouer comme
        // un gros « boum » faisait battre le son toutes les 320 ms pendant le
        // tassement naturel ou l'erosion. Le vrai son d'effondrement reste
        // declenche une seule fois par les actions explicites (seau rate) ; ici
        // on ne garde que le retour visuel de poussiere.
        // OUTILS 3D : un panache de poussiere par evenement, plafonne — lors
        // d'un gros effondrement il y en a des centaines par frame. Quatorze
        // lignes, et une avalanche passe de « les polygones bougent » a
        // « quelque chose s'ecroule ».
        if (this.particles && Math.random() < 0.15) {
          // Les evenements du granulaire sont en coordonnees VOXEL.
          this.particles.burst(2,
            ORIGIN_X + (e.x + 0.5) * VOXEL,
            (e.y + 0.5) * VOXEL,
            ORIGIN_Z + (e.z + 0.5) * VOXEL,
          3, { speed: 0.5, spread: 1.0 });
        }
      }
      // Les evenements sont un flux de la frame physique, pas un etat. Sans
      // consommation ils etaient rejoues sur chaque frame de rendu jusqu'au
      // prochain pas structurel, source du bruit et de particules repetes.
      this.granular.events.length = 0;
    }

    // --- maillage ------------------------------------------------------------
    tm = performance.now(); // PERF
    const focus = this.tools.hit ? this.tools.hit.point : this.controls.target;
    this.mesher.prioritize(focus.x, focus.z);
    this.mesher.collect(BUDGET_REMESH * 6);
    P.mesh += -tm + (tm = performance.now()); // PERF
    this.stats.meshQueue = this.mesher.busy;
    this.stats.triangles = this.terrain.triangles;
    this.stats.activeVoxels = this.granular.stats.active;
    this.stats.wetCells = this.water.stats.wetCells;
    this.stats.tide = this.water.tidePhase;

    // --- eau -----------------------------------------------------------------
    tm = performance.now(); // PERF
    this.waterRenderer.update(
      dt, this.sky.sunDir, this.sky.sun.color,
      this.sky.uniforms.uZenith.value, this.sky.uniforms.uHorizon.value
    );
    // Le champ d'eau que lisent le sable et le decor change d'objet quand le
    // GPU prend (ou rend) les champs fins : on le repointe alors.
    const ft = this.waterRenderer.fieldTexture;
    if (ft !== this._fieldTexBound) {
      this._fieldTexBound = ft;
      this.props.setWaterField(ft);
      this.sandMaterial.userData.uniforms.uField.value = ft;
    }
    P.waterTex += -tm + (tm = performance.now()); // PERF

    // --- rendu ---------------------------------------------------------------
    if (this.post) this.post.sunDir.copy(this.sky.sunDir);
    // La bande nette du tilt-shift suit ce que le joueur regarde.
    this.post?.focusOn(this.tools.hit ? this._tmpVec.set(
      this.tools.hit.point.x, this.tools.hit.point.y, this.tools.hit.point.z
    ) : this.controls.target, dt);
    // Capture le decor sans eau juste avant la passe principale. Le shader de
    // surface peut alors deplacer cette image avec le vrai rayon refracte.
    this.waterRenderer.captureRefraction(this.renderer, this.camera);
    if (this.post) this.post.render(dt);
    else this.renderer.render(this.scene, this.camera);
    P.render += -tm + (tm = performance.now()); // PERF

    this.autoQuality(dt);
    this.updateNarration(dt);
    this.save?.update(dt);
    this.hud?.update(dt);
    // PERF (fin de frame)
    P.hud += performance.now() - tm;
    P.total += performance.now() - tF;
    P.frames++;

    this._frames++;
    this._fpsTimer += dt;
    if (this._fpsTimer >= 0.5) {
      this.stats.fps = this._frames / this._fpsTimer;
      this._frames = 0;
      this._fpsTimer = 0;
    }
  }

  /**
   * Un pas de simulation physique.
   * L'ordre compte : le sable bouge, on rafraichit les hauteurs de colonne,
   * puis l'eau — qui lit ces hauteurs — coule et erode, et on rafraichit a
   * nouveau avant le maillage.
   */
  step(dt) {
    // PERF : les trois postes de la simulation, flush de colonnes inclus.
    const P = this.perf;
    let tm = performance.now();
    this.granular.step(dt, Math.round(BUDGET_GRANULAR * this.simBudget));
    this.field.flushColumns();
    P.gran += -tm + (tm = performance.now());
    this.moisture.step(dt, this.sky.insolation);
    P.moist += -tm + (tm = performance.now());
    this.water.step(dt);
    this.field.flushColumns();
    P.water += -tm + (tm = performance.now());
  }

  dispose() {
    this.tools?.dispose();
    this.toolAvatar?.dispose();
    this.droppedTools?.dispose();
    this.particles?.dispose();
    this.mesher?.dispose();
    this.terrain?.dispose();
    this.waterRenderer?.dispose();
    this.props?.dispose();
    this.controls?.dispose();
    this.sky?.dispose();
    this.audio?.dispose();
    this.post?.dispose();
    this.renderer?.dispose();
  }
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
