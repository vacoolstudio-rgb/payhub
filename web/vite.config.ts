import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * Proxy instead of CORS in development.
     *
     * Same-origin requests mean the refresh-token cookie (httpOnly,
     * SameSite=strict) actually reaches the API — with a cross-origin dev
     * server it would be dropped, and the auth flow would behave
     * differently locally than in production.
     */
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/graphql': { target: 'http://localhost:3000', changeOrigin: true },
      // Socket.IO always talks over `/socket.io`; `/realtime` is only the
      // namespace, not the HTTP path. Proxying the namespace alone is the
      // classic reason a gateway "never connects".
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
