import { defineConfig } from 'vite';

// En-tetes qui activent crossOriginIsolated -> SharedArrayBuffer dispo pour le
// pool de workers de maillage. En production ils sont poses par l'hebergeur
// (voir vercel.json) ; ici pour `vite dev` et `vite preview`.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    // Les tests Puppeteer ecrivent leurs captures dans `shots/`, qui est dans
    // la racine du projet : sans cette exclusion, chaque capture declenche un
    // rechargement complet de la page EN PLEIN TEST, et `window.game`
    // disparait sous les pieds du scenario.
    watch: { ignored: ['**/shots/**', '**/dist/**'] },
    headers: ISOLATION_HEADERS,
  },
  preview: { headers: ISOLATION_HEADERS },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      output: {
        // three.js dans son propre chunk : il change rarement, le navigateur
        // le garde en cache d'un deploiement a l'autre.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
