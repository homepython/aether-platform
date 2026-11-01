import React, { Suspense, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { isDesktopClient } from './bridge/DesktopBridge.js';
import { AuthView } from './components/AuthView.js';
import { DesktopTitlebar } from './components/DesktopTitlebar.js';
import { LandingPage } from './components/LandingPage.js';
import { useAppStore } from './store/useAppStore.js';

const WorkspaceShell = React.lazy(() =>
  import('./components/WorkspaceShell.js').then((m) => ({ default: m.WorkspaceShell }))
);

export const App: React.FC = () => {
  const bootstrapping = useAppStore((s) => s.bootstrapping);
  const viewMode = useAppStore((s) => s.viewMode);
  const user = useAppStore((s) => s.user);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const desktop = isDesktopClient();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const loadingFallback = (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3"
      style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
    >
      <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
      <span className="text-xs font-medium">Conectando ao Aether...</span>
    </div>
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <DesktopTitlebar />

      {bootstrapping ? (
        loadingFallback
      ) : !desktop ? (
        viewMode === 'auth' && !user ? (
          <AuthView />
        ) : (
          <LandingPage />
        )
      ) : viewMode === 'landing' && !user ? (
        <LandingPage />
      ) : !user || viewMode === 'auth' ? (
        <AuthView />
      ) : (
        <Suspense fallback={loadingFallback}>
          <WorkspaceShell />
        </Suspense>
      )}
    </div>
  );
};

