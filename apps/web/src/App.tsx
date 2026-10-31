import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthView } from './components/AuthView.js';
import { DesktopTitlebar } from './components/DesktopTitlebar.js';
import { LandingPage } from './components/LandingPage.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { useAppStore } from './store/useAppStore.js';

export const App: React.FC = () => {
  const bootstrapping = useAppStore((s) => s.bootstrapping);
  const viewMode = useAppStore((s) => s.viewMode);
  const user = useAppStore((s) => s.user);
  const bootstrap = useAppStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <DesktopTitlebar />

      {bootstrapping ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3"
          style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
        >
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-medium">Conectando ao Aether...</span>
        </div>
      ) : viewMode === 'landing' && !user ? (
        <LandingPage />
      ) : !user || viewMode === 'auth' ? (
        <AuthView />
      ) : (
        <WorkspaceShell />
      )}
    </div>
  );
};

