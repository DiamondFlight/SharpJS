import { defineConfig } from 'vite';

// The standalone web app lives in app/ and imports the library straight from src/.
export default defineConfig({
  root: 'app',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
});
