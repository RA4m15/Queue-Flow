import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initTheme } from './services/theme';
import './index.css';

// Put the stored theme on <html> before the first render, so the state a
// component reads and the attribute CSS is painting against are the same.
initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
