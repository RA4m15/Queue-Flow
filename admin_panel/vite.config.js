import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly rather than silently moving the Admin Panel, so the
    // documented :5173 URL always points at this app.
    strictPort: true,
    host: 'localhost',
  },
});
