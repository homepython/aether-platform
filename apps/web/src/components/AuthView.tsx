import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  CheckCircle2,
  Globe,
  Loader2,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Sun,
  User,
  WifiOff,
} from 'lucide-react';
import {
  api,
  getServerBaseUrl,
  setServerBaseUrl,
  type ServerHealthStatus,
} from '../api/httpClient.js';
import { isDesktopClient } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';

export const AuthView: React.FC = () => {
  const login = useAppStore((s) => s.login);
  const register = useAppStore((s) => s.register);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const theme = useAppStore((s) => s.settings.interface.theme);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showServerConfig, setShowServerConfig] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => getServerBaseUrl());
  const [checkingServer, setCheckingServer] = useState(false);
  const [serverHealth, setServerHealth] = useState<ServerHealthStatus | null>(null);

  const probeServer = async (targetUrl?: string, autoExpandIfOffline = false) => {
    setCheckingServer(true);
    const res = await api.checkServerHealth(targetUrl || serverUrl);
    setServerHealth(res);
    setCheckingServer(false);
    if (!res.ok && autoExpandIfOffline) {
      setShowServerConfig(true);
    }
  };

  useEffect(() => {
    void probeServer(getServerBaseUrl(), isDesktopClient());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveAndTestServer = async () => {
    if (serverUrl.trim()) {
      setServerBaseUrl(serverUrl.trim());
    }
    await probeServer(serverUrl.trim(), false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (showServerConfig && serverUrl.trim()) {
      setServerBaseUrl(serverUrl.trim());
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        await login({ identifier, password });
      } else {
        await register({
          username,
          displayName: displayName.trim() || username,
          email,
          password,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível autenticar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-10"
      style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)' }}
    >
      <div className="mb-6 flex w-full max-w-md items-center justify-between">
        {!isDesktopClient() ? (
          <button
            type="button"
            onClick={() => setViewMode('landing')}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Página inicial
          </button>
        ) : (
          <div />
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowServerConfig((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors"
            style={{
              borderColor:
                serverHealth && !serverHealth.ok ? 'rgba(239, 68, 68, 0.45)' : 'var(--border-hairline)',
              backgroundColor: 'var(--bg-surface)',
              color:
                serverHealth && !serverHealth.ok ? 'var(--live-red)' : 'var(--text-secondary)',
            }}
          >
            {serverHealth?.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5" style={{ color: 'var(--voice-green)' }} />
            ) : serverHealth && !serverHealth.ok ? (
              <WifiOff className="h-3.5 w-3.5" />
            ) : (
              <Globe className="h-3.5 w-3.5" />
            )}
            {serverHealth?.ok ? `Online (${serverHealth.latencyMs}ms)` : 'Servidor'}
          </button>
          <button
            type="button"
            onClick={() =>
              updateSettings((prev) => ({
                ...prev,
                interface: {
                  ...prev.interface,
                  theme: prev.interface.theme === 'dark' ? 'light' : 'dark',
                },
              }))
            }
            className="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md rounded-3xl border p-8"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="mb-7 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-base font-bold text-white"
            style={{ background: 'linear-gradient(135deg, #2563EB, #0EA5E9)' }}
          >
            A
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === 'login' ? 'Entrar no Aether' : 'Criar sua conta'}
            </h1>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Voz, chat e transmissões reais em alta definição
            </p>
          </div>
        </div>

        {/* Mode Segmented Control */}
        <div
          className="mb-6 grid grid-cols-2 rounded-xl p-1 text-xs font-medium"
          style={{ backgroundColor: 'var(--bg-sidebar)' }}
        >
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className="rounded-lg py-2 transition-all"
            style={{
              backgroundColor: mode === 'login' ? 'var(--bg-surface)' : 'transparent',
              color: mode === 'login' ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: mode === 'login' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
            }}
          >
            Entrar
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className="rounded-lg py-2 transition-all"
            style={{
              backgroundColor: mode === 'register' ? 'var(--bg-surface)' : 'transparent',
              color: mode === 'register' ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: mode === 'register' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
            }}
          >
            Criar Conta
          </button>
        </div>

        {showServerConfig && (
          <div
            className="mb-5 rounded-xl border p-3.5"
            style={{
              borderColor: 'var(--border-hairline)',
              backgroundColor: 'var(--bg-sidebar)',
            }}
          >
            <label className="mb-1.5 block text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              URL do Servidor Cloud / Online
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://seu-dominio-online.com"
                className="flex-1 rounded-lg border px-3 py-2 text-xs outline-none"
                style={{
                  borderColor: 'var(--border-strong)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
              <button
                type="button"
                disabled={checkingServer}
                onClick={() => void handleSaveAndTestServer()}
                className="rounded-lg px-3 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                {checkingServer ? 'Testando...' : 'Conectar'}
              </button>
            </div>
            {serverHealth && (
              <div
                className="mt-2 text-[11px]"
                style={{ color: serverHealth.ok ? 'var(--voice-green)' : 'var(--live-red)' }}
              >
                {serverHealth.ok
                  ? `Conectado ao servidor (${serverHealth.latencyMs}ms • banco: ${serverHealth.database || 'ativo'})`
                  : `${serverHealth.error || 'Offline'} — informe o endereço HTTPS do servidor em nuvem`}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'login' ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Usuário ou E-mail
              </label>
              <div className="relative">
                <User
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                />
                <input
                  type="text"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="seu.usuario ou voce@dominio.com"
                  className="h-11 w-full rounded-xl border pl-10 pr-3.5 text-sm outline-none transition-colors"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Usuário (@menção)
                  </label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="lucas"
                    className="h-11 w-full rounded-xl border px-3.5 text-sm outline-none"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Nome de Exibição
                  </label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Lucas Silva"
                    className="h-11 w-full rounded-xl border px-3.5 text-sm outline-none"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  E-mail
                </label>
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2"
                    style={{ color: 'var(--text-muted)' }}
                  />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@dominio.com"
                    className="h-11 w-full rounded-xl border pl-10 pr-3.5 text-sm outline-none"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Senha
            </label>
            <div className="relative">
              <Lock
                className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              />
              <input
                type="password"
                required
                minLength={mode === 'register' ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-11 w-full rounded-xl border pl-10 pr-3.5 text-sm outline-none"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            {mode === 'register' && (
              <p
                className="mt-1.5 flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--voice-green)' }} />
                Mín. 8 caracteres com maiúscula, minúscula e número ou símbolo (hash scrypt + AES-256-GCM)
              </p>
            )}
          </div>

          {error && (
            <div
              className="rounded-xl border px-3.5 py-2.5 text-xs font-medium"
              style={{
                borderColor: 'rgba(239, 68, 68, 0.35)',
                backgroundColor: 'var(--live-red-soft)',
                color: 'var(--live-red)',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-95 disabled:opacity-60"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'login' ? 'Entrar na Plataforma' : 'Criar Conta e Conectar'}
          </button>
        </form>
      </motion.div>
    </div>
  );
};

