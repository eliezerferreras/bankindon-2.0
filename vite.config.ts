import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Configuración del frontend.
 *
 * Antes, todo el código (incluida una sola pantalla de 100 KB) salía en un
 * único chunk: cualquier cambio invalidaba la caché completa del navegador y
 * el primer render tenía que descargar y parsear todo.
 *
 * Ahora las dependencias estables (React) van en su propio chunk, que cambia
 * muy rara vez y por tanto se cachea de forma indefinida en los clientes.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // El navegador objetivo es el de un panel administrativo moderno.
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // React y su runtime cambian poco: chunk propio y muy cacheable.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
