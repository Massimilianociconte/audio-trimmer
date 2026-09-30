import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import './styles.css';

// Aggiornamenti PWA senza sorprese: quando il nuovo service worker è in
// attesa, la app mostra un banner "Ricarica ora" invece di ricaricare da sola
// (mai mentre si taglia audio).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('workbox-window').then(({ Workbox }) => {
    const wb = new Workbox('./sw.js', { scope: './' });
    const notifyWaiting = () => window.dispatchEvent(new CustomEvent('app-sw-waiting'));
    wb.addEventListener('waiting', notifyWaiting);
    wb.addEventListener('externalwaiting', notifyWaiting);
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
    window.addEventListener('app-sw-skip', () => {
      // Workbox messageSkipWaiting() returns void, not a Promise.
      try {
        wb.messageSkipWaiting();
      } catch {
        window.location.reload();
      }
    }, { once: true });
    wb.register().catch(() => {});
  }).catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
