import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fixtureApi } from './fixture-api';

// `vite --mode fixture` serves a local stand-in API (see fixture-api.ts); otherwise /api goes to a local Worker.
// CK_FIXTURE in an untracked .env.fixture.local may point at a saved scan result to review real data locally, and
// CK_CATALOG at a Worker origin whose public catalogs match it, and CK_PREVIEWS at a folder of part pictures.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CK_');
  return {
    plugins: [react(), ...(mode === 'fixture' ? [fixtureApi(env.CK_FIXTURE, env.CK_CATALOG, env.CK_PREVIEWS)] : [])],
    server: mode === 'fixture' ? {} : { proxy: { '/api': 'http://localhost:8787', '/oauth': 'http://localhost:8787' } },
  };
});
