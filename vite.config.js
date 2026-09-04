import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    // Les tests Puppeteer ecrivent leurs captures dans `shots/`, qui est dans
    // la racine du projet : sans cette exclusion, chaque capture declenche un
    // rechargement complet de la page EN PLEIN TEST, et `window.game`
    // disparait sous les pieds du scenario.
    watch: { ignored: ['**/shots/**', '**/dist/**'] },
    headers: {
      // Active crossOriginIsolated -> SharedArrayBuffer dispo pour le pool de workers.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: { format: 'es' },
  build: { target: 'esnext', sourcemap: true },
});
