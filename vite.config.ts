import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { compactCatalogue } from './lib/catalogue-payload';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [
    {
      name: 'compact-catalogue-payload',
      enforce: 'pre',
      transform(source: string, id: string) {
        if (id.split('?')[0].replace(/\\/g, '/').endsWith('/lib/catalogue-data.json'))
          return { code: compactCatalogue(source), map: null };
      },
    },
    react(),
  ],
});
