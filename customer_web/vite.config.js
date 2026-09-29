import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned deliberately. The Live Counter builds the canonical customer join
    // QR from VITE_CUSTOMER_WEB_URL, and that value points at this origin.
    // strictPort makes a port clash fail loudly instead of silently moving this
    // app to another port and breaking the QR shown on the display.
    port: 5175,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
})
