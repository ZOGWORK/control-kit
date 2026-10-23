import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Session = { connected: boolean; setupPending?: boolean; user?: { id: string; name: string } };
const context = new URLSearchParams(location.search);
const required = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'];
const workerUrl = import.meta.env.VITE_WORKER_URL ?? '';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`${workerUrl}/api/session`, { credentials: 'include' })
      .then(async result => result.ok ? await result.json() as Session : { connected: false })
      .then(setSession)
      .catch(() => { setError('Could not check the Onshape connection. Reload this panel.'); setSession({ connected: false }); });
  }, []);
  if (required.some(key => !context.get(key))) return <main><h1>Control Kit</h1><p>Open an Assembly tab in Onshape, then launch Control Kit from its right panel.</p></main>;
  const connect = `${workerUrl}/oauth/start?${new URLSearchParams(required.map(key => [key, context.get(key)!]))}`;
  return <main>
    <h1>Control Kit</h1>
    {error && <p role="alert">{error}</p>}
    {!session && <p>Checking Onshape connection…</p>}
    {session?.setupPending && <p>Onshape connection setup is in progress. Return after the OAuth application is linked.</p>}
    {session && !session.connected && !session.setupPending && <><p>Connect Onshape to prepare your assembly BOM.</p><a className="button" href={connect}>Connect Onshape</a></>}
    {session?.connected && <><p>Connected as {session.user?.name}.</p><p>Assembly {context.get('elementId')} is ready. Scanning arrives in M2.</p></>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
