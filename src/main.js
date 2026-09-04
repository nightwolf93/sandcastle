import { Game } from './core/Game.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bootFill = document.getElementById('boot-fill');

const game = new Game(canvas, (p, label) => {
  bootFill.style.width = `${Math.round(p * 100)}%`;
  if (label) bootStatus.textContent = label;
});

window.game = game; // pratique pour bidouiller depuis la console

game
  .init()
  .then(() => {
    boot.classList.add('done');
    setTimeout(() => boot.remove(), 700);

    let last = performance.now();
    function loop(now) {
      const dt = (now - last) / 1000;
      last = now;
      game.update(dt);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  })
  .catch((err) => {
    console.error(err);
    bootStatus.textContent = 'Erreur : ' + err.message;
    bootStatus.style.color = '#c0392b';
  });
