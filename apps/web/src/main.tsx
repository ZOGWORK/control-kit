import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/theme.css';

// Arc reads its dark tokens from data-theme; Control Kit is always dark, like the other Control apps.
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
