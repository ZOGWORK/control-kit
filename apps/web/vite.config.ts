import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fixtureApi } from './fixture-api';

// `vite --mode fixture` serves a local stand-in API (see fixture-api.ts); otherwise /api goes to a local Worker.
// CK_FIXTURE in an untracked .env.fixture.local may point at a saved scan result to review real data locally.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'fixture' ? [fixtureApi(loadEnv(mode, process.cwd(), 'CK_').CK_FIXTURE)] : [])],
  server: mode === 'fixture' ? {} : { proxy: { '/api': 'http://localhost:8787', '/oauth': 'http://localhost:8787' } },
}));
