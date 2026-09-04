/**
 * Gestion des outils : entrees, visee, cadence, annulation.
 *
 * Regles d'ergonomie retenues (le point dur d'un jeu de sculpture a la souris,
 * c'est de choisir une profondeur en 3D avec un peripherique 2D) :
 *
 *   - la brosse se projette TOUJOURS sur la surface du sable ; on ne sculpte
 *     jamais dans le vide ;
 *   - Ctrl pendant un geste VERROUILLE l'altitude : le rayon est alors
 *     intersecte avec le plan horizontal du point de depart. C'est ce qui
 *     permet de creuser une tranchee a fond plat ou d'araser un mur ;
 *   - Maj verrouille la direction du geste sur l'axe dominant, pour des
 *     traits droits ;
 *   - la molette nue ZOOME, ancree sur le curseur (c'est ce que tout le monde
 *     attend) ; le rayon de brosse se regle avec Ctrl+molette et aux touches
 *     [ et ].
 */

import * as THREE from 'three';
import { TOOLS, TOOL_BY_ID, DECOR_VARIANTS } from './tools.js';
import * as Brush from './Brush.js';
import { EditContext } from './Brush.js';
import { SandBuilderPreview, smoothSandPath, sandPathLength } from './SandBuilder.js';
import { UndoStack } from './UndoStack.js';
import { clamp, NX, NY, NZ, ORIGIN_X, ORIGIN_Z, WORLD_W, WORLD_D } from '../core/Config.js';
import { ToolGhost } from '../render/ToolGhost.js';
import {
  mirrorPoint, mirrorVector, stampRevolution, cylinderProfile, coneProfile, domeProfile,
} from './Sculpt.js';

export class ToolManager {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;

    this.undo = new UndoStack(game.field);
    this.ctx = new EditContext(game.field, game.granular, game.moisture, game.water, this.undo);
    // Expose les operations de brosse : utile pour les tests automatises et
    // pour scripter des constructions depuis la console.
    this.brush = Brush;

    this.tools = TOOLS;
    this.current = TOOL_BY_ID.shovel;
    this.radius = this.current.radius.def;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0);
    this.hasPointer = false;

    /** Dernier point vise (surface du sable). */
    this.hit = null;
    /** Etat du geste en cours. */
    this.stroke = null;
    this.accumulator = 0;

    this.shift = false;
    this.ctrl = false;
    this.alt = false;

    /** Rayon de la brosse -> anneau dans le shader du sable. */
    this.cursorFade = 0;

    /** Apercu volumique du generateur de blocs et de murs. */
    this.sandPreview = new SandBuilderPreview(game.scene);
    /** Apercus filaires : ouverture, escalier, regle, axe du miroir. */
    this.ghost = new ToolGhost(game.scene);
    /** Mode miroir : chaque geste est repete de l'autre cote du plan. */
    this.mirror = { on: false, axis: 'x', pos: 0 };
    this._guide = null;
    this._guideKey = '';

    this.enabled = true;
    this.listeners = [];
    this.bind();
  }

  bind() {
    const c = this.canvas;
    const on = (el, ev, fn, opts) => {
      el.addEventListener(ev, fn, opts);
      this.listeners.push([el, ev, fn]);
    };
    on(c, 'pointerdown', (e) => this.onDown(e));
    on(window, 'pointermove', (e) => this.onMove(e));
    on(window, 'pointerup', (e) => this.onUp(e));
    on(c, 'pointerleave', () => { this.hasPointer = false; });
    on(c, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(window, 'keydown', (e) => this.onKeyDown(e));
    on(window, 'keyup', (e) => this.onKeyUp(e));
  }

  dispose() {
    for (const [el, ev, fn] of this.listeners) el.removeEventListener(ev, fn);
    this.listeners.length = 0;
    this.sandPreview.dispose();
  }

  // -------------------------------------------------------------------------
  // SELECTION
  // -------------------------------------------------------------------------

  select(id) {
    const t = TOOL_BY_ID[id];
    if (!t || t === this.current) return;
    this.endStroke();
    this.sandPreview.hide();
    this.current = t;
    this.radius = t.radius.def;
    this.game.onToolChanged?.(t);
  }

  setRadius(r) {
    const t = this.current;
    this.radius = clamp(r, t.radius.min, t.radius.max);
    this.game.onToolChanged?.(t);
  }

  /** Change le sous-outil du generateur sans perdre ses dimensions. */
  setSandMode(mode) {
    const t = TOOL_BY_ID.sand;
    if (!t || !['block', 'wall', 'tower', 'dome'].includes(mode) || t.mode === mode) return;
    this.endStroke();
    t.mode = mode;
    this.sandPreview.hide();
    this.game.onToolChanged?.(t);
  }

  /** Point d'entree unique des curseurs du panneau de construction. */
  setSandSetting(key, value) { this.setToolSetting('sand', key, value); }

  /** Regle un parametre d'un outil (les jauges des panneaux passent par ici). */
  setToolSetting(id, key, value) {
    const t = TOOL_BY_ID[id];
    if (!t || !(key in t)) return;
    t[key] = value;
    if (t.builder) this.sandPreview.hide();
    if (this.current === t) this.game.onToolChanged?.(t);
  }

  // -------------------------------------------------------------------------
  // ENTREES
  // -------------------------------------------------------------------------

  updatePointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.hasPointer = true;
  }

  onDown(e) {
    if (!this.enabled) return;
    if (e.button !== 0 && e.button !== 2) return;
    // Les modificateurs de camera ont la priorite.
    if (e.altKey) return;
    this.updatePointer(e);

    // PRIORITE AU RAMASSAGE : un clic sur un outil au sol le reprend, et ne
    // creuse pas. Sans cette priorite, cliquer sur une pelle plantee
    // creuserait un trou dessous. Le raycast contre 12 meshes est negligeable
    // devant le raycast voxel qui suit.
    if (e.button === 0 && this.game.droppedTools) {
      const it = this.game.droppedTools.pick(this.pointer, this.game.camera);
      if (it) {
        e.preventDefault();
        this.select(it.id);
        this.game.toolAvatar?.pickUp(it);
        return;
      }
    }
    // Un clic reprend en main l'outil qu'on avait plante : jamais d'impasse.
    this.game.toolAvatar?.unstow();

    const hit = this.raycast();
    if (!hit) return;
    e.preventDefault();

    if (this.current.builder) {
      this.beginSandGesture(e, hit);
      return;
    }

    this.undo.beginGroup(this.current.name);
    this.stroke = {
      button: e.button,
      lockY: null,
      lastPoint: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      startPoint: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      applied: 0,
    };
    this.accumulator = 0;
    this.hit = hit;

    const s = this.makeState(hit, 0);
    this.current.down?.(s);
    // Premiere application immediate : un clic bref doit faire quelque chose.
    this.applyOnce(1 / (this.current.rate || 12));
  }

  onMove(e) {
    if (!this.enabled) return;
    this.updatePointer(e);
    // Surbrillance au survol d'un outil au sol, seulement hors geste. Le
    // lisere suffit : le clic est le geste par defaut, il n'y a rien a
    // expliquer.
    if (!this.stroke && this.game.droppedTools) {
      this.game.droppedTools.setHover(
        this.game.droppedTools.pick(this.pointer, this.game.camera));
    }
  }

  onUp(e) {
    if (!this.stroke) return;
    if (e.button !== this.stroke.button) return;
    const hit = this.stroke.builder ? (this.raycast() || this.hit) : (this.hit || this.raycast());
    if (this.stroke.builder) {
      this.finishSandGesture(hit);
      return;
    }
    if (hit) {
      const s = this.makeState(hit, 0);
      this.current.up?.(s);
      if (this.mirrorActive && this.current.up) this.current.up(this.mirrorState(s));
    }
    this.endStroke();
  }

  endStroke() {
    if (!this.stroke) return;
    this.stroke = null;
    this.undo.endGroup();
  }

  onWheel(e) {
    if (!this.enabled) return;
    // La molette nue appartient a la camera. Le rayon se regle avec Ctrl.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const t = this.current;
    if (e.shiftKey && t.id === 'rake') {
      t.spacing = clamp(t.spacing * Math.exp(-e.deltaY * 0.0016), 0.02, 0.22);
      this.game.onToolChanged?.(t);
      return;
    }
    if (e.shiftKey && t.id === 'hand') {
      t.intensity = clamp(t.intensity - e.deltaY * 0.0008, 0, 1);
      this.game.onToolChanged?.(t);
      return;
    }
    if (e.shiftKey && t.id === 'decor') {
      const n = DECOR_VARIANTS.length;
      t.variant = (t.variant + (e.deltaY > 0 ? 1 : n - 1)) % n;
      this.game.toast('Objet : ' + DECOR_VARIANTS[t.variant].name);
      this.game.onToolChanged?.(t);
      return;
    }
    this.setRadius(this.radius * Math.exp(-e.deltaY * 0.0018));
  }

  onKeyDown(e) {
    this.shift = e.shiftKey; this.ctrl = e.ctrlKey || e.metaKey; this.alt = e.altKey;
    if (e.target instanceof HTMLInputElement) return;

    if (e.code === 'Escape' && this.stroke?.builder) {
      e.preventDefault();
      this.endStroke();
      this.sandPreview.hide();
      this.game.toast('Trace annule');
      return;
    }
    if (e.code === 'Escape' && this.stroke && this.current.single) {
      // Escalier : le trace est abandonne sans rien tailler.
      e.preventDefault();
      this.endStroke();
      this.game.toast('Geste annule');
      return;
    }
    if (e.code === 'Escape' && this.current.id === 'measure') {
      const t = this.current;
      t.a = null; t.b = null; t.readout = '';
      return;
    }
    if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!this.enabled) return;
      e.preventDefault();
      this.toggleMirror(e.shiftKey);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      const label = this.doUndo(e.shiftKey);
      if (label) {
        this.game.toast((e.shiftKey ? 'Refait : ' : 'Annule : ') + label);
      } else {
        this.game.toast(e.shiftKey ? 'Rien a refaire' : 'Rien a annuler');
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault();
      if (this.doUndo(true)) this.game.toast('Refait');
      return;
    }

    // G comme « ground ». Le clic droit, lui, est deja l'action secondaire de
    // chacun des dix outils — c'est un pilier de la conception, on ne le
    // sacrifie pas pour lacher un objet. La branche est APRES le test du champ
    // de saisie, sinon G partirait pendant qu'on tape.
    if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Mode photo : les outils sont desactives, G ne doit pas entailler le
      // sable en douce pendant que le HUD est cache.
      if (!this.enabled) return;
      e.preventDefault();
      this.game.toolAvatar?.plant(e.shiftKey ? 'lay' : 'stab', this.hit, this.ctx);
      return;
    }

    for (const t of this.tools) {
      if (t.key === e.code) { this.select(t.id); return; }
    }
    if (e.code === 'BracketLeft') this.setRadius(this.radius * 0.85);
    if (e.code === 'BracketRight') this.setRadius(this.radius / 0.85);
  }

  onKeyUp(e) {
    this.shift = e.shiftKey; this.ctrl = e.ctrlKey || e.metaKey; this.alt = e.altKey;
  }

  /**
   * Annule (ou refait) le dernier geste et reveille la physique sur tout le
   * domaine. Point d'entree UNIQUE : le raccourci clavier et le bouton du HUD
   * doivent faire exactement la meme chose — avant, le bouton oubliait le
   * reveil granulaire et forcait un remaillage complet meme quand il n'y
   * avait rien a annuler.
   */
  doUndo(redo = false) {
    const label = redo ? this.undo.redo() : this.undo.undo();
    if (label) this.game.granular.wakeBox(0, 0, 0, NX - 1, NY - 1, NZ - 1);
    return label;
  }

  // -------------------------------------------------------------------------
  // VISEE
  // -------------------------------------------------------------------------

  /**
   * Lance un rayon depuis la souris.
   * Avec l'altitude verrouillee, on intersecte un plan horizontal au lieu du
   * terrain : c'est ce qui permet de creuser plat.
   */
  raycast() {
    if (!this.hasPointer) return null;
    this.raycaster.setFromCamera(this.pointer, this.game.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;

    if (this.stroke && this.ctrl) {
      if (this.stroke.lockY === null) this.stroke.lockY = this.stroke.startPoint.y;
      const y = this.stroke.lockY;
      if (Math.abs(d.y) > 1e-4) {
        const t = (y - o.y) / d.y;
        if (t > 0) {
          return {
            point: { x: o.x + d.x * t, y, z: o.z + d.z * t },
            normal: { x: 0, y: 1, z: 0 },
            distance: t,
            locked: true,
          };
        }
      }
    }

    return this.game.field.raycast(
      { x: o.x, y: o.y, z: o.z },
      { x: d.x, y: d.y, z: d.z },
      60
    );
  }

  makeState(hit, dt) {
    return {
      ctx: this.ctx,
      hit,
      dt,
      radius: this.radius,
      button: this.stroke ? this.stroke.button : 0,
      shift: this.shift,
      ctrl: this.ctrl,
      alt: this.alt,
      game: this.game,
      tool: this.current,
      stroke: this.stroke,
    };
  }

  /** L'etat symetrique d'un geste, pour le mode miroir. */
  mirrorState(s) {
    const m = this.mirror;
    const hit = {
      ...s.hit,
      point: mirrorPoint(s.hit.point, m.axis, m.pos),
      normal: s.hit.normal ? mirrorVector(s.hit.normal, m.axis) : s.hit.normal,
    };
    const stroke = s.stroke ? {
      ...s.stroke,
      lastPoint: mirrorPoint(s.stroke.lastPoint, m.axis, m.pos),
      startPoint: mirrorPoint(s.stroke.startPoint, m.axis, m.pos),
    } : null;
    return { ...s, hit, stroke, mirrored: true, mirrorAxis: m.axis };
  }

  /** Le miroir suit-il cet outil ? (pas la regle, pas le generateur) */
  get mirrorActive() {
    return this.mirror.on && !this.current.builder && this.current.mirrorable !== false;
  }

  /**
   * M : miroir a l'endroit du curseur, sur l'axe courant. Maj+M : l'autre
   * axe. Un chateau symetrique se bat en deux fois moins de gestes.
   */
  toggleMirror(flipAxis = false) {
    const m = this.mirror;
    if (flipAxis) { m.axis = m.axis === 'x' ? 'z' : 'x'; m.on = true; }
    else m.on = !m.on;
    if (m.on && this.hit) m.pos = m.axis === 'x' ? this.hit.point.x : this.hit.point.z;
    this._guideKey = '';
    this.game.hud?.setMirror?.(m.on, m.axis);
    this.game.toast(m.on
      ? `Miroir ${m.axis === 'x' ? 'gauche-droite' : 'avant-arriere'} (Maj+M : autre axe)`
      : 'Miroir desactive');
  }

  /** Trait de l'axe du miroir, pose sur le terrain. */
  mirrorGuide() {
    const m = this.mirror, F = this.game.field;
    const key = `${m.axis}:${m.pos.toFixed(3)}:${F.surfaceVersion}`;
    if (key === this._guideKey && this._guide) return this._guide;
    this._guideKey = key;
    const pts = [];
    const step = 0.16;
    if (m.axis === 'x') {
      for (let z = ORIGIN_Z; z <= ORIGIN_Z + WORLD_D + 1e-6; z += step) {
        pts.push({ x: m.pos, y: F.surfaceHeightAt(m.pos, z) + 0.01, z });
      }
    } else {
      for (let x = ORIGIN_X; x <= ORIGIN_X + WORLD_W + 1e-6; x += step) {
        pts.push({ x, y: F.surfaceHeightAt(x, m.pos) + 0.01, z: m.pos });
      }
    }
    this._guide = { lines: [pts], color: '#8fd0ff' };
    return this._guide;
  }

  /** Apercus du geste en cours (ou a venir) et guide du miroir. */
  updateGhost(hit, dt) {
    const specs = [];
    if (this.mirror.on) specs.push(this.mirrorGuide());
    if (hit && this.current.preview && !this.current.builder) {
      const spec = this.current.preview(this.makeState(hit, dt));
      if (spec) {
        specs.push(spec);
        if (this.mirrorActive) {
          const ms = this.current.preview(this.mirrorState(this.makeState(hit, dt)));
          if (ms) specs.push(ms);
        }
      }
    }
    this.ghost.set(specs.length ? specs : null);
  }

  // -------------------------------------------------------------------------
  // GENERATEUR DE SABLE
  // -------------------------------------------------------------------------

  beginSandGesture(e, hit) {
    const t = this.current;
    // Le clic droit sert de sortie immediate pendant la construction : aucune
    // matiere n'est ecrite avant la validation d'un mur.
    if (e.button === 2) {
      this.endStroke();
      this.sandPreview.hide();
      return;
    }

    this.undo.beginGroup(t.mode === 'block' ? 'Bloc de sable' : 'Mur de sable');
    this.stroke = {
      button: e.button,
      builder: true,
      lockY: null,
      lastPoint: { ...hit.point },
      startPoint: { ...hit.point },
      path: [{ ...hit.point }],
      applied: 0,
    };
    this.hit = hit;

    if (t.mode === 'block') {
      Brush.stampSandBox(this.ctx, hit.point.x, hit.point.y, hit.point.z,
        t.blockWidth, t.blockLength, t.height, t.rotation,
        t.buildMoisture, t.buildPacking);
      this.stroke.applied = 1;
      this.game.audio?.play('place');
      this.game.particles?.ring(0, hit.point, Math.max(t.blockWidth, t.blockLength) * 0.45, 10, 0.24);
    } else if (t.mode === 'tower') {
      const p = hit.point;
      stampRevolution(this.ctx, p.x, p.y, p.z, t.towerHeight,
        cylinderProfile(t.towerRadius, t.towerTaper), t.buildMoisture, t.buildPacking);
      if (t.roof) {
        stampRevolution(this.ctx, p.x, p.y + t.towerHeight, p.z, t.roofHeight,
          coneProfile(t.towerRadius * (1 - t.towerTaper) * 1.08), t.buildMoisture, t.buildPacking);
      }
      this.stroke.applied = 1;
      this.game.audio?.play('place');
      this.game.particles?.ring(0, hit.point, t.towerRadius, 10, 0.24);
    } else if (t.mode === 'dome') {
      const p = hit.point;
      stampRevolution(this.ctx, p.x, p.y, p.z, t.domeHeight,
        domeProfile(t.domeRadius), t.buildMoisture, t.buildPacking);
      this.stroke.applied = 1;
      this.game.audio?.play('place');
      this.game.particles?.ring(0, hit.point, t.domeRadius, 10, 0.24);
    } else {
      this.sandPreview.update(t, hit.point, this.stroke.path);
    }
  }

  /** Ajoute un point au trace, avec Maj pour verrouiller X ou Z. */
  appendSandPoint(hit, force = false) {
    const s = this.stroke;
    if (!s?.builder || this.current.mode !== 'wall' || !hit) return;
    let p = { ...hit.point };
    if (this.shift) {
      const dx = p.x - s.startPoint.x;
      const dz = p.z - s.startPoint.z;
      if (Math.abs(dx) >= Math.abs(dz)) p.z = s.startPoint.z;
      else p.x = s.startPoint.x;
      p.y = this.game.field.surfaceHeightAt(p.x, p.z);
    }
    const last = s.path[s.path.length - 1];
    const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
    const spacing = Math.max(0.045, this.current.wallWidth * 0.24);
    if (!force && d < spacing) return;
    if (force && d < 0.008) return;
    s.path.push(p);
    s.lastPoint = { ...p };
    this.sandPreview.update(this.current, p, s.path);
  }

  finishSandGesture(hit) {
    const s = this.stroke;
    const t = this.current;
    if (!s?.builder) return;

    if (t.mode === 'wall') {
      this.appendSandPoint(hit, true);
      const path = smoothSandPath(s.path, t.smoothness);
      if (path.length >= 2 && sandPathLength(path) >= Math.max(0.10, t.wallWidth * 0.65)) {
        Brush.stampSandWall(this.ctx, path, t.wallWidth, t.wallHeight, {
          crenels: t.crenels,
          crenelWidth: t.crenelWidth,
          crenelHeight: t.crenelHeight,
          moisture: t.buildMoisture,
          packing: t.buildPacking,
        });
        s.applied = 1;
        const last = path[path.length - 1];
        this.game.audio?.play('place');
        this.game.particles?.ring(0, last, t.wallWidth, 10, 0.24);
      } else {
        this.game.toast('Trace un mur en maintenant le clic');
      }
    }

    this.stroke = null;
    this.undo.endGroup();
    this.sandPreview.hide();
  }

  applyOnce(dt) {
    if (!this.stroke || !this.hit) return;
    const s = this.makeState(this.hit, dt);
    this.current.apply?.(s);
    if (this.mirrorActive && this.current.apply) this.current.apply(this.mirrorState(s));
    // Anticipation / frappe / accompagnement : l'impact va dans l'OBJET, pas
    // dans la camera. Pas de screen shake sur un diorama en orbite.
    this.game.toolAvatar?.strike();
    this.stroke.applied++;
    this.stroke.lastPoint.x = this.hit.point.x;
    this.stroke.lastPoint.y = this.hit.point.y;
    this.stroke.lastPoint.z = this.hit.point.z;
  }

  // -------------------------------------------------------------------------
  // BOUCLE
  // -------------------------------------------------------------------------

  update(dt) {
    if (!this.enabled) {
      this.fadeCursor(dt, 0);
      this.sandPreview.hide();
      this.ghost.hide();
      this.updateCursorUniforms(null);
      return;
    }

    const hit = this.raycast();
    this.hit = hit;
    this.updateGhost(hit, dt);

    if (this.current.builder) {
      if (this.stroke?.builder && this.current.mode === 'wall' && hit) this.appendSandPoint(hit);
      const path = this.stroke?.builder ? this.stroke.path : [];
      const previewPoint = hit?.point || path[path.length - 1] || null;
      this.sandPreview.update(this.current, previewPoint, path);
      this.fadeCursor(dt, 0);
      this.updateCursorUniforms(null);
      return;
    }
    this.sandPreview.hide();

    // Un outil « a coup unique » (ouverture, escalier, regle) a deja agi au
    // clic ou agira au relachement : rien ne se repete pendant le maintien.
    if (this.stroke && hit && !this.current.single) {
      // Cadence fixe : independante du framerate, sinon la quantite de matiere
      // deplacee dependrait de la machine.
      const period = 1 / (this.current.rate || 12);
      this.accumulator += dt;
      let n = 0;
      while (this.accumulator >= period && n < 4) {
        this.accumulator -= period;
        this.applyOnce(period);
        n++;
      }
    } else if (!this.stroke) {
      this.accumulator = 0;
    }

    this.fadeCursor(dt, hit ? 1 : 0);
    this.updateCursorUniforms(hit);
  }

  fadeCursor(dt, target) {
    const k = 1 - Math.pow(0.001, dt);
    this.cursorFade += (target - this.cursorFade) * k;
  }

  updateCursorUniforms(hit) {
    const u = this.game.sandMaterial.userData.uniforms;
    if (hit) {
      u.uCursor.value.set(hit.point.x, hit.point.y, hit.point.z, this.radius);
      const col = this.current.cursor || '#7ec8ff';
      u.uCursorColor.value.set(col);
    }
    u.uCursorStrength.value = this.current.builder ? 0 : this.cursorFade;
  }

  /** Informations affichees dans le HUD sous le curseur. */
  probe() {
    const hit = this.hit;
    if (!hit) return null;
    const F = this.game.field;
    const w = F.averageMoisture(hit.point.x, hit.point.y, hit.point.z, Math.max(0.08, this.radius * 0.7));
    const p = F.averagePacking(hit.point.x, hit.point.y, hit.point.z, Math.max(0.08, this.radius * 0.7));
    const depth = this.game.water.depthAt(hit.point.x, hit.point.z);
    return { point: hit.point, moisture: w, packing: p, waterDepth: depth };
  }
}
