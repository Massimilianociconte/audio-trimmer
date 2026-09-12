import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App crash:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="shell">
          <div className="error-fallback" role="alert">
            <p className="section-label">Qualcosa è andato storto</p>
            <h2>L’app si è interrotta, ma nessun file è stato caricato online.</h2>
            <p className="helper-text">
              {this.state.error?.message || 'Errore imprevisto del motore locale.'}
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => window.location.reload()}
            >
              Ricarica l’app
            </button>
            <p className="helper-text">
              Suggerimento: i progetti salvati restano in IndexedDB e si ritrovano dopo il reload.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
