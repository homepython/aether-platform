import React from 'react';
import { Minus, Square, X, Radio, Layers } from 'lucide-react';
import { getDesktopApi } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';

export const DesktopTitlebar: React.FC = () => {
  const desktop = getDesktopApi();
  const wsConnected = useAppStore((s) => s.wsConnected);
  const minimizeToTray = useAppStore((s) => s.settings.app.minimizeToTrayOnClose);
  const overlayEnabled = useAppStore((s) => s.settings.app.overlay.enabled);
  const updateSettings = useAppStore((s) => s.updateSettings);

  if (!desktop) return null;

  return (
    <header
      className="desktop-drag flex h-9 shrink-0 select-none items-center justify-between border-b px-3.5 text-xs"
      style={{
        backgroundColor: 'var(--bg-sidebar)',
        borderColor: 'var(--border-hairline)',
        color: 'var(--text-secondary)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #2563EB, #0EA5E9)' }}
        >
          A
        </div>
        <span className="font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          Aether
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            backgroundColor: wsConnected ? 'var(--voice-green-soft)' : 'var(--bg-hover)',
            color: wsConnected ? 'var(--voice-green)' : 'var(--text-muted)',
          }}
        >
          <Radio className="h-2.5 w-2.5" />
          {wsConnected ? 'Tempo Real Conectado' : 'Sincronizando'}
        </span>
      </div>

      <div className="desktop-no-drag flex items-center gap-1">
        <button
          type="button"
          onClick={() =>
            updateSettings((prev) => ({
              ...prev,
              app: {
                ...prev.app,
                overlay: { ...prev.app.overlay, enabled: !prev.app.overlay.enabled },
              },
            }))
          }
          title="Alternar Overlay em Jogos"
          className="mr-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          style={{
            backgroundColor: overlayEnabled ? 'var(--accent-soft)' : 'transparent',
            color: overlayEnabled ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <Layers className="h-3 w-3" />
          Overlay {overlayEnabled ? 'Ativo' : 'Off'}
        </button>

        <button
          type="button"
          onClick={() => desktop.minimizeWindow()}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          aria-label="Minimizar"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => desktop.maximizeOrRestoreWindow()}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          aria-label="Maximizar"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => desktop.closeWindow(minimizeToTray)}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-red-500 hover:text-white"
          aria-label="Fechar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
};

