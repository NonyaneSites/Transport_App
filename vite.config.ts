import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Keep heavy export and canvas libraries in their own on-demand chunks (never in entry or vendor bundle)
            if (
              id.includes('xlsx') ||
              id.includes('jspdf') ||
              id.includes('html2canvas') ||
              id.includes('dompurify')
            ) {
              return undefined;
            }
            // 1. Supabase client vendor chunk
            if (id.includes('@supabase')) {
              return 'vendor-supabase';
            }
            // 2. Core React & UI vendor chunk
            return 'vendor-core';
          }
        },
      },
    },
  },
});
