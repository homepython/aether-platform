import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Download,
  ExternalLink,
  Headphones,
  Layers,
  LogOut,
  Mic,
  MonitorPlay,
  Moon,
  ShieldCheck,
  Sun,
  UserCheck,
  Volume2,
  Zap,
} from 'lucide-react';
import { api, resolveServerAssetUrl } from '../api/httpClient.js';
import { isDesktopClient } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';
import { AdminModal } from './AdminModal.js';
import { StyledUserName, UserRoleBadge } from './UserIdentity.js';

export const LandingPage: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setAdminModalOpen = useAppStore((s) => s.setAdminModalOpen);
  const logout = useAppStore((s) => s.logout);
  const theme = useAppStore((s) => s.settings.interface.theme);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const desktop = isDesktopClient();

  const [release, setRelease] = useState<{
    version: string;
    platform: string;
    available: boolean;
    filename: string;
    sizeBytes: number | null;
    downloadUrl: string;
  } | null>(null);

  useEffect(() => {
    api
      .getReleaseInfo()
      .then((info) => setRelease(info))
      .catch(() => {});
  }, []);

  const formatMb = (bytes: number | null) => {
    if (!bytes) return '';
    return ` • ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const toggleTheme = () => {
    updateSettings((prev) => ({
      ...prev,
      interface: {
        ...prev.interface,
        theme: prev.interface.theme === 'dark' ? 'light' : 'dark',
      },
    }));
  };

  return (
    <div
      className="min-h-screen w-full overflow-y-auto transition-colors duration-300"
      style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)' }}
    >
      {/* Top Navigation */}
      <nav
        className="glass-panel sticky top-0 z-30 border-b"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm"
              style={{ background: 'linear-gradient(135deg, #2563EB, #0EA5E9)' }}
            >
              A
            </div>
            <div>
              <span className="text-base font-semibold tracking-tight">Aether</span>
              <span
                className="ml-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                style={{
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                }}
              >
                Studio Realtime
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-9 w-9 items-center justify-center rounded-xl border transition-colors"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
              title={theme === 'dark' ? 'Mudar para Tema Claro' : 'Mudar para Tema Escuro'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {user ? (
              <>
                <div
                  className="hidden items-center gap-2 rounded-xl border px-3 py-1.5 text-sm sm:inline-flex"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-surface)',
                  }}
                >
                  <UserCheck className="h-3.5 w-3.5" style={{ color: 'var(--voice-green)' }} />
                  <StyledUserName name={user.displayName} role={user.role} className="max-w-[160px]" />
                  <UserRoleBadge role={user.role} compact />
                </div>

                {desktop && (
                  <button
                    type="button"
                    onClick={() => setViewMode('app')}
                    className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-medium text-white transition-all hover:opacity-95"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    Abrir Salas
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setAdminModalOpen(true)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-secondary)',
                  }}
                  title="Central de Administração"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Administração</span>
                </button>

                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border transition-colors"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-muted)',
                  }}
                  title="Sair da conta"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setViewMode('auth')}
                className="inline-flex h-9 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors"
                style={{
                  borderColor: 'var(--border-strong)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                Entrar na Conta
              </button>
            )}

            {!desktop && (
              <a
                href={resolveServerAssetUrl(release?.downloadUrl || '/api/releases/desktop/windows')}
                download
                className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-medium text-white transition-all hover:opacity-95"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Baixar Desktop</span>
              </a>
            )}
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-20">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto max-w-3xl text-center"
        >
          <div
            className="mb-6 inline-flex items-center gap-2 rounded-full border px-3.5 py-1 text-xs font-medium"
            style={{
              borderColor: 'var(--border-strong)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Engenharia SFU em Tempo Real • 1440p 75 FPS • Zero Audio Ducking
          </div>

          <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
            Voz cristalina e transmissões em{' '}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6, #0EA5E9)' }}
            >
              2K 75 FPS
            </span>{' '}
            sem concessões.
          </h1>

          <p
            className="mx-auto mt-6 max-w-2xl text-base leading-relaxed sm:text-lg"
            style={{ color: 'var(--text-secondary)' }}
          >
            Projetado desde o kernel de áudio até a nuvem para jogadores exigentes e equipes criativas.
            O volume da live jamais abaixa quando alguém fala, zero eco por isolamento de processo e
            latência imperceptível.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3.5 sm:flex-row">
            <a
              href={resolveServerAssetUrl(release?.downloadUrl || '/api/releases/desktop/windows')}
              download
              className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-2xl px-7 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-[1.015] active:scale-[0.99] sm:w-auto"
              style={{
                background: 'linear-gradient(135deg, #2563EB, #0284C7)',
              }}
            >
              <Download className="h-4 w-4" />
              <span>
                Baixar Aether Desktop para Windows
                {release?.available ? formatMb(release.sizeBytes) : ' (64-bit)'}
              </span>
            </a>

            {desktop ? (
              <button
                type="button"
                onClick={() => setViewMode(user ? 'app' : 'auth')}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl border px-7 text-sm font-semibold transition-colors sm:w-auto"
                style={{
                  borderColor: 'var(--border-strong)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                {user ? 'Abrir Salas' : 'Entrar na Conta'}
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <a
                href="aether-app://open"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl border px-7 text-sm font-semibold transition-colors sm:w-auto"
                style={{
                  borderColor: 'var(--border-strong)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                Já instalou? Abrir Aplicativo Desktop
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>

          <p className="mx-auto mt-4 max-w-xl text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Comunicação por voz, salas e transmissões ao vivo funcionam exclusivamente no Aplicativo
            Desktop Windows para máxima performance de GPU e áudio isolado sem eco.
          </p>
        </motion.div>

        {/* Precision Engineering Grid */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="mt-20 grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[
            {
              icon: Volume2,
              title: 'Zero Audio Ducking',
              desc: 'Filmes, músicas e jogos permanecem exatamente no mesmo volume quando alguém fala. Barramentos de áudio 100% isolados em Opus Estéreo 320 kbps.',
            },
            {
              icon: ShieldCheck,
              title: 'Zero Eco e Zero Retorno',
              desc: 'Captura nativa WASAPI por árvore de processo no Windows exclui automaticamente as vozes da sala da transmissão de tela cheia.',
            },
            {
              icon: MonitorPlay,
              title: '720p, 1080p e 1440p a 75 FPS',
              desc: 'Codificação H.264 High Level 5.2 e AV1 por hardware com resolução travada (maintain-resolution) para textos e interfaces ultra definidos.',
            },
            {
              icon: Mic,
              title: 'Áudio Neural RNNoise 48 kHz',
              desc: 'Rede neural em tempo real via AudioWorklet elimina coolers, teclados mecânicos e ruídos contínuos sem deixar a voz robótica.',
            },
            {
              icon: Layers,
              title: 'Overlay In-Game Sem Foco',
              desc: 'Veja quem está falando sobre qualquer jogo com posição, escala e opacidade ajustáveis sem jamais minimizar ou roubar cliques.',
            },
            {
              icon: Zap,
              title: 'Desempenho Intacto nos Jogos',
              desc: 'Quem transmite não decodifica o próprio vídeo. Painel profissional de telemetria leve com FPS, resolução e espectadores reais.',
            },
          ].map((feat) => {
            const Icon = feat.icon;
            return (
              <div
                key={feat.title}
                className="rounded-2xl border p-6 transition-all"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-hairline)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div
                  className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: 'var(--accent-soft)',
                    color: 'var(--accent)',
                  }}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold tracking-tight">{feat.title}</h3>
                <p
                  className="mt-2 text-sm leading-relaxed"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {feat.desc}
                </p>
              </div>
            );
          })}
        </motion.div>

        {/* Bottom Spec Strip */}
        <div
          className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-6 py-5 text-xs"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-hairline)',
            color: 'var(--text-secondary)',
          }}
        >
          <div className="flex items-center gap-2.5">
            <Headphones className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            <span>Controle individual de volume (0–200%) e filtro individual de ruído por participante</span>
          </div>
          <div className="font-medium tabular-nums">
            Arquitetura Cloud Multi-Core SFU • Aplicativo Desktop Windows 10/11
          </div>
        </div>
      </main>

      {user && <AdminModal />}
    </div>
  );
};

