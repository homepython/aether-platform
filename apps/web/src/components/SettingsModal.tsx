import React, { useEffect, useState } from 'react';
import {
  AppWindow,
  Keyboard,
  Mic,
  MonitorPlay,
  Palette,
  Volume2,
  X,
} from 'lucide-react';
import {
  STREAM_FPS_OPTIONS,
  STREAM_RESOLUTIONS,
  STREAM_RESOLUTION_SPECS,
  resolveTargetBitrateKbps,
  type OverlayPositionPreset,
  type ShortcutSettings,
} from '@aether/shared';
import { audioEngine } from '../audio/AudioEngine.js';
import { isDesktopClient } from '../bridge/DesktopBridge.js';
import { useAppStore } from '../store/useAppStore.js';

function formatKeyComboEvent(e: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(e.code || e.key);
  return parts.join('+');
}

export const SettingsModal: React.FC = () => {
  const open = useAppStore((s) => s.settingsModalOpen);
  const activeTab = useAppStore((s) => s.settingsActiveTab);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const localMicDb = useAppStore((s) => s.localMicDb);

  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [testingMic, setTestingMic] = useState(false);
  const [recordingShortcutKey, setRecordingShortcutKey] = useState<
    keyof ShortcutSettings | 'pttKey' | null
  >(null);

  useEffect(() => {
    if (!open) {
      setTestingMic(false);
      setRecordingShortcutKey(null);
      return;
    }

    const loadDevices = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(list.filter((d) => d.kind === 'audioinput'));
        setOutputDevices(list.filter((d) => d.kind === 'audiooutput'));
      } catch {
        // Ignore
      }
    };

    void loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices);
    };
  }, [open]);

  if (!open) return null;

  const toggleMicTest = async () => {
    const next = !testingMic;
    setTestingMic(next);
    if (next) {
      await audioEngine.startMicrophone(settings.audio).catch(() => {});
    }
    audioEngine.setMicLoopbackTest(next);
  };

  const meterPercent = Math.max(0, Math.min(100, ((localMicDb + 85) / 85) * 100));
  const vadThresholdPercent = Math.max(
    0,
    Math.min(100, ((settings.audio.vadSensitivityDb + 85) / 85) * 100)
  );

  const autoBitrateKbps = resolveTargetBitrateKbps(
    settings.stream.resolution,
    settings.stream.fps,
    null
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-backdrop)' }}
    >
      <div
        className="flex h-[84vh] w-full max-w-4xl overflow-hidden rounded-3xl border"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-hairline)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        {/* Left Navigation */}
        <div
          className="flex w-56 shrink-0 flex-col justify-between border-r p-4"
          style={{
            backgroundColor: 'var(--bg-sidebar)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="space-y-1">
            <div
              className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Configurações
            </div>

            {(
              [
                { id: 'audio', label: 'Áudio & Voz', icon: Mic },
                { id: 'stream', label: 'Transmissão', icon: MonitorPlay },
                { id: 'app', label: 'Aplicativo & Overlay', icon: AppWindow },
                { id: 'interface', label: 'Interface & Temas', icon: Palette },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const isCurrent = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openSettings(item.id)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-all"
                  style={{
                    backgroundColor: isCurrent ? 'var(--bg-active)' : 'transparent',
                    color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  <Icon
                    className="h-4 w-4"
                    style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-muted)' }}
                  />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="px-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Aether v1.0.0 • Sincronização automática ativa
          </div>
        </div>

        {/* Right Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            className="flex items-center justify-between border-b px-7 py-4"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <h2 className="text-base font-semibold">
              {activeTab === 'audio' && 'Engenharia de Áudio & Voz'}
              {activeTab === 'stream' && 'Qualidade de Transmissão'}
              {activeTab === 'app' && 'Aplicativo, Bandeja, Overlay & Atalhos'}
              {activeTab === 'interface' && 'Aparência, Temas & Notificações'}
            </h2>
            <button
              type="button"
              onClick={closeSettings}
              className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-7 py-6 text-sm">
            {/* TAB 1: AUDIO */}
            {activeTab === 'audio' && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Dispositivo de Entrada (Microfone)
                    </label>
                    <select
                      value={settings.audio.inputDeviceId}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, inputDeviceId: e.target.value },
                        }))
                      }
                      className="h-10 w-full rounded-xl border px-3 text-xs outline-none"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <option value="default">Padrão do Sistema</option>
                      {inputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Microfone (${d.deviceId.slice(0, 6)})`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Dispositivo de Saída (Fones / Caixas)
                    </label>
                    <select
                      value={settings.audio.outputDeviceId}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, outputDeviceId: e.target.value },
                        }))
                      }
                      className="h-10 w-full rounded-xl border px-3 text-xs outline-none"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <option value="default">Padrão do Sistema</option>
                      {outputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Saída de Áudio (${d.deviceId.slice(0, 6)})`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Input & Output Volume */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div
                    className="rounded-2xl border p-4"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                    }}
                  >
                    <div className="mb-2 flex justify-between text-xs font-medium">
                      <span>Volume do Microfone</span>
                      <span className="tabular-nums">{settings.audio.inputVolume}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={settings.audio.inputVolume}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, inputVolume: Number(e.target.value) },
                        }))
                      }
                      className="aether-range w-full"
                    />
                  </div>

                  <div
                    className="rounded-2xl border p-4"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: 'var(--bg-elevated)',
                    }}
                  >
                    <div className="mb-2 flex justify-between text-xs font-medium">
                      <span>Volume Geral de Saída</span>
                      <span className="tabular-nums">{settings.audio.outputVolume}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={settings.audio.outputVolume}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, outputVolume: Number(e.target.value) },
                        }))
                      }
                      className="aether-range w-full"
                    />
                  </div>
                </div>

                {/* Mic Test & Live Meter */}
                <div
                  className="rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold">Teste de Microfone & Sensibilidade</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Nível atual: <span className="tabular-nums">{Math.round(localMicDb)} dB</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggleMicTest()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold text-white"
                      style={{
                        backgroundColor: testingMic ? 'var(--live-red)' : 'var(--accent)',
                      }}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                      {testingMic ? 'Parar Teste' : 'Testar Microfone'}
                    </button>
                  </div>

                  <div
                    className="relative h-3 w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: 'var(--bg-sidebar)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-75"
                      style={{
                        width: `${meterPercent}%`,
                        backgroundColor:
                          localMicDb >= settings.audio.vadSensitivityDb
                            ? 'var(--voice-green)'
                            : 'var(--text-muted)',
                      }}
                    />
                    {settings.audio.voiceMode === 'vad' && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-amber-400"
                        style={{ left: `${vadThresholdPercent}%` }}
                      />
                    )}
                  </div>
                </div>

                {/* Voice Activation vs Push-To-Talk */}
                <div
                  className="space-y-4 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, voiceMode: 'vad' },
                        }))
                      }
                      className="rounded-xl border py-2.5 text-xs font-semibold transition-all"
                      style={{
                        borderColor:
                          settings.audio.voiceMode === 'vad'
                            ? 'var(--accent)'
                            : 'var(--border-hairline)',
                        backgroundColor:
                          settings.audio.voiceMode === 'vad'
                            ? 'var(--bg-active)'
                            : 'var(--bg-surface)',
                      }}
                    >
                      Detecção de Voz (VAD)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: { ...prev.audio, voiceMode: 'ptt' },
                        }))
                      }
                      className="rounded-xl border py-2.5 text-xs font-semibold transition-all"
                      style={{
                        borderColor:
                          settings.audio.voiceMode === 'ptt'
                            ? 'var(--accent)'
                            : 'var(--border-hairline)',
                        backgroundColor:
                          settings.audio.voiceMode === 'ptt'
                            ? 'var(--bg-active)'
                            : 'var(--bg-surface)',
                      }}
                    >
                      Push-To-Talk (Pressione para Falar)
                    </button>
                  </div>

                  {settings.audio.voiceMode === 'vad' ? (
                    <div>
                      <div className="mb-1.5 flex justify-between text-xs">
                        <span style={{ color: 'var(--text-secondary)' }}>Sensibilidade de Ativação</span>
                        <span className="font-semibold tabular-nums">
                          {settings.audio.vadSensitivityDb} dB
                        </span>
                      </div>
                      <input
                        type="range"
                        min={-80}
                        max={-10}
                        value={settings.audio.vadSensitivityDb}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            audio: { ...prev.audio, vadSensitivityDb: Number(e.target.value) },
                          }))
                        }
                        className="aether-range w-full"
                      />
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Tecla Push-To-Talk
                        </label>
                        <button
                          type="button"
                          onClick={() => setRecordingShortcutKey('pttKey')}
                          onKeyDown={(e) => {
                            if (recordingShortcutKey !== 'pttKey') return;
                            e.preventDefault();
                            const combo = formatKeyComboEvent(e);
                            if (combo) {
                              updateSettings((prev) => ({
                                ...prev,
                                audio: { ...prev.audio, pttKey: combo },
                                app: {
                                  ...prev.app,
                                  shortcuts: { ...prev.app.shortcuts, pushToTalk: combo },
                                },
                              }));
                              setRecordingShortcutKey(null);
                            }
                          }}
                          onMouseDown={(e) => {
                            if (recordingShortcutKey !== 'pttKey') return;
                            if (e.button === 3 || e.button === 4) {
                              e.preventDefault();
                              const mouseBtn = e.button === 3 ? 'Mouse4' : 'Mouse5';
                              updateSettings((prev) => ({
                                ...prev,
                                audio: { ...prev.audio, pttKey: mouseBtn },
                              }));
                              setRecordingShortcutKey(null);
                            }
                          }}
                          className="flex h-10 w-full items-center justify-between rounded-xl border px-3.5 text-xs font-semibold"
                          style={{
                            borderColor:
                              recordingShortcutKey === 'pttKey'
                                ? 'var(--accent)'
                                : 'var(--border-strong)',
                            backgroundColor: 'var(--bg-surface)',
                          }}
                        >
                          <span>
                            {recordingShortcutKey === 'pttKey'
                              ? 'Pressione uma tecla ou botão Mouse4/5...'
                              : settings.audio.pttKey}
                          </span>
                          <Keyboard className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        </button>
                      </div>

                      <div>
                        <div className="mb-1.5 flex justify-between text-xs">
                          <span style={{ color: 'var(--text-secondary)' }}>Atraso ao Soltar</span>
                          <span className="font-semibold tabular-nums">
                            {settings.audio.pttReleaseDelayMs} ms
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={800}
                          step={20}
                          value={settings.audio.pttReleaseDelayMs}
                          onChange={(e) =>
                            updateSettings((prev) => ({
                              ...prev,
                              audio: {
                                ...prev.audio,
                                pttReleaseDelayMs: Number(e.target.value),
                              },
                            }))
                          }
                          className="aether-range mt-2 w-full"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* DSP Noise Suppression, Noise Gate & Echo Cancellation */}
                <div
                  className="space-y-4 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold">
                          Supressão Neural de Ruído (RNNoise 48 kHz)
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          Remove ventiladores, teclados e som ambiente preservando o timbre natural
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.audio.noiseSuppressionEnabled}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            audio: {
                              ...prev.audio,
                              noiseSuppressionEnabled: e.target.checked,
                            },
                          }))
                        }
                        className="h-4 w-4 accent-blue-600"
                      />
                    </div>
                    {settings.audio.noiseSuppressionEnabled && (
                      <div className="mt-2.5 flex items-center gap-3">
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Intensidade de Supressão
                        </span>
                        <input
                          type="range"
                          min={10}
                          max={100}
                          value={settings.audio.noiseSuppressionLevel}
                          onChange={(e) =>
                            updateSettings((prev) => ({
                              ...prev,
                              audio: {
                                ...prev.audio,
                                noiseSuppressionLevel: Number(e.target.value),
                              },
                            }))
                          }
                          className="aether-range flex-1"
                        />
                        <span className="w-10 text-right text-xs font-semibold tabular-nums">
                          {settings.audio.noiseSuppressionLevel}%
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="border-t pt-3.5" style={{ borderColor: 'var(--border-hairline)' }}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold">Noise Gate com Histerese</div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          Silencia completamente o canal quando você não está falando
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.audio.noiseGateEnabled}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            audio: { ...prev.audio, noiseGateEnabled: e.target.checked },
                          }))
                        }
                        className="h-4 w-4 accent-blue-600"
                      />
                    </div>
                    {settings.audio.noiseGateEnabled && (
                      <div className="mt-2.5 flex items-center gap-3">
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Limiar do Gate
                        </span>
                        <input
                          type="range"
                          min={-80}
                          max={-15}
                          value={settings.audio.noiseGateThresholdDb}
                          onChange={(e) =>
                            updateSettings((prev) => ({
                              ...prev,
                              audio: {
                                ...prev.audio,
                                noiseGateThresholdDb: Number(e.target.value),
                              },
                            }))
                          }
                          className="aether-range flex-1"
                        />
                        <span className="w-12 text-right text-xs font-semibold tabular-nums">
                          {settings.audio.noiseGateThresholdDb} dB
                        </span>
                      </div>
                    )}
                  </div>

                  <div
                    className="flex items-center justify-between border-t pt-3.5"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <div>
                      <div className="text-xs font-semibold">Cancelamento Acústico de Eco (AEC3)</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Impede retorno acústico caso utilize caixas de som sem fones
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.audio.echoCancellationEnabled}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          audio: {
                            ...prev.audio,
                            echoCancellationEnabled: e.target.checked,
                          },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>
                </div>
              </>
            )}

            {/* TAB 2: STREAM */}
            {activeTab === 'stream' && (
              <>
                <div>
                  <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Resolução Padrão de Transmissão
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {STREAM_RESOLUTIONS.map((resId) => {
                      const spec = STREAM_RESOLUTION_SPECS[resId];
                      const active = settings.stream.resolution === resId;
                      return (
                        <button
                          key={resId}
                          type="button"
                          onClick={() =>
                            updateSettings((prev) => ({
                              ...prev,
                              stream: { ...prev.stream, resolution: resId },
                            }))
                          }
                          className="rounded-2xl border p-3.5 text-left transition-all"
                          style={{
                            borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                            backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                          }}
                        >
                          <div className="text-sm font-semibold">{spec.label}</div>
                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {spec.sublabel}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Taxa de Quadros Padrão (FPS)
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {STREAM_FPS_OPTIONS.map((fpsVal) => {
                      const active = settings.stream.fps === fpsVal;
                      return (
                        <button
                          key={fpsVal}
                          type="button"
                          onClick={() =>
                            updateSettings((prev) => ({
                              ...prev,
                              stream: { ...prev.stream, fps: fpsVal },
                            }))
                          }
                          className="rounded-2xl border py-3 text-center text-sm font-semibold tabular-nums transition-all"
                          style={{
                            borderColor: active ? 'var(--accent)' : 'var(--border-hairline)',
                            backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                          }}
                        >
                          {fpsVal} FPS
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="space-y-4 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold">Controle de Bitrate de Vídeo</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Automático calibrado para nitidez máxima ({(autoBitrateKbps / 1000).toFixed(1)} Mbps)
                      </div>
                    </div>
                    <div className="flex gap-1.5 text-xs font-semibold">
                      <button
                        type="button"
                        onClick={() =>
                          updateSettings((prev) => ({
                            ...prev,
                            stream: { ...prev.stream, bitrateMode: 'auto', customBitrateKbps: null },
                          }))
                        }
                        className="rounded-lg px-3 py-1.5"
                        style={{
                          backgroundColor:
                            settings.stream.bitrateMode === 'auto'
                              ? 'var(--accent)'
                              : 'var(--bg-surface)',
                          color:
                            settings.stream.bitrateMode === 'auto'
                              ? '#ffffff'
                              : 'var(--text-secondary)',
                        }}
                      >
                        Automático
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateSettings((prev) => ({
                            ...prev,
                            stream: {
                              ...prev.stream,
                              bitrateMode: 'custom',
                              customBitrateKbps: prev.stream.customBitrateKbps || autoBitrateKbps,
                            },
                          }))
                        }
                        className="rounded-lg px-3 py-1.5"
                        style={{
                          backgroundColor:
                            settings.stream.bitrateMode === 'custom'
                              ? 'var(--accent)'
                              : 'var(--bg-surface)',
                          color:
                            settings.stream.bitrateMode === 'custom'
                              ? '#ffffff'
                              : 'var(--text-secondary)',
                        }}
                      >
                        Manual
                      </button>
                    </div>
                  </div>

                  {settings.stream.bitrateMode === 'custom' && (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={STREAM_RESOLUTION_SPECS[settings.stream.resolution].minBitrateKbps}
                        max={STREAM_RESOLUTION_SPECS[settings.stream.resolution].maxBitrateKbps}
                        step={500}
                        value={settings.stream.customBitrateKbps || autoBitrateKbps}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            stream: {
                              ...prev.stream,
                              customBitrateKbps: Number(e.target.value),
                            },
                          }))
                        }
                        className="aether-range flex-1"
                      />
                      <span className="w-20 text-right text-xs font-semibold tabular-nums">
                        {((settings.stream.customBitrateKbps || autoBitrateKbps) / 1000).toFixed(1)} Mbps
                      </span>
                    </div>
                  )}
                </div>

                <div
                  className="flex items-center justify-between rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div>
                    <div className="text-xs font-semibold">Compartilhar Áudio por Padrão</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Áudio estéreo 48 kHz 320 kbps sem redução quando alguém falar
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.stream.shareAudio}
                    onChange={(e) =>
                      updateSettings((prev) => ({
                        ...prev,
                        stream: { ...prev.stream, shareAudio: e.target.checked },
                      }))
                    }
                    className="h-4 w-4 accent-blue-600"
                  />
                </div>
              </>
            )}

            {/* TAB 3: APP, TRAY, OVERLAY & SHORTCUTS */}
            {activeTab === 'app' && (
              <>
                <div
                  className="space-y-3.5 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Sistema & Bandeja {!isDesktopClient() && '(Aplicado automaticamente no App Desktop)'}
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold">Inicialização Automática com o Windows</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Abrir o Aether automaticamente ao iniciar sua sessão
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.app.autoStartOnBoot}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          app: { ...prev.app, autoStartOnBoot: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>

                  <div
                    className="flex items-center justify-between border-t pt-3"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <div>
                      <div className="text-xs font-semibold">Minimizar para a Bandeja ao Fechar</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Mantém chamadas de voz ativas em segundo plano como Discord/TeamSpeak
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.app.minimizeToTrayOnClose}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          app: { ...prev.app, minimizeToTrayOnClose: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>
                </div>

                {/* In-Game Overlay */}
                <div
                  className="space-y-4 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold">Overlay em Jogos (Sem Roubar Foco)</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Exibe quem está falando sobre jogos sem interceptar cliques
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.app.overlay.enabled}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          app: {
                            ...prev.app,
                            overlay: { ...prev.app.overlay, enabled: e.target.checked },
                          },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Posição do Overlay na Tela
                    </label>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {(
                        [
                          { id: 'top-left', label: 'Superior Esq.' },
                          { id: 'top-right', label: 'Superior Dir.' },
                          { id: 'middle-left', label: 'Centro Esq.' },
                          { id: 'middle-right', label: 'Centro Dir.' },
                          { id: 'bottom-left', label: 'Inferior Esq.' },
                          { id: 'bottom-right', label: 'Inferior Dir.' },
                        ] as { id: OverlayPositionPreset; label: string }[]
                      ).map((pos) => (
                        <button
                          key={pos.id}
                          type="button"
                          onClick={() =>
                            updateSettings((prev) => ({
                              ...prev,
                              app: {
                                ...prev.app,
                                overlay: { ...prev.app.overlay, position: pos.id },
                              },
                            }))
                          }
                          className="rounded-xl border py-2 font-medium"
                          style={{
                            borderColor:
                              settings.app.overlay.position === pos.id
                                ? 'var(--accent)'
                                : 'var(--border-hairline)',
                            backgroundColor:
                              settings.app.overlay.position === pos.id
                                ? 'var(--bg-active)'
                                : 'var(--bg-surface)',
                          }}
                        >
                          {pos.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 flex justify-between text-xs">
                        <span style={{ color: 'var(--text-secondary)' }}>Escala do Overlay</span>
                        <span className="font-semibold tabular-nums">
                          {Math.round(settings.app.overlay.scale * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={70}
                        max={150}
                        value={Math.round(settings.app.overlay.scale * 100)}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            app: {
                              ...prev.app,
                              overlay: {
                                ...prev.app.overlay,
                                scale: Number(e.target.value) / 100,
                              },
                            },
                          }))
                        }
                        className="aether-range w-full"
                      />
                    </div>

                    <div>
                      <div className="mb-1 flex justify-between text-xs">
                        <span style={{ color: 'var(--text-secondary)' }}>Opacidade</span>
                        <span className="font-semibold tabular-nums">
                          {Math.round(settings.app.overlay.opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={20}
                        max={100}
                        value={Math.round(settings.app.overlay.opacity * 100)}
                        onChange={(e) =>
                          updateSettings((prev) => ({
                            ...prev,
                            app: {
                              ...prev.app,
                              overlay: {
                                ...prev.app.overlay,
                                opacity: Number(e.target.value) / 100,
                              },
                            },
                          }))
                        }
                        className="aether-range w-full"
                      />
                    </div>
                  </div>
                </div>

                {/* Global Shortcuts */}
                <div
                  className="space-y-3 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="text-xs font-semibold">Atalhos de Teclado</div>
                  {(
                    [
                      { key: 'toggleMute', label: 'Silenciar / Ativar Microfone' },
                      { key: 'toggleDeafen', label: 'Desativar / Reativar Áudio' },
                      { key: 'toggleOverlay', label: 'Mostrar / Ocultar Overlay' },
                      { key: 'stopStream', label: 'Encerrar Transmissão Ativa' },
                    ] as { key: keyof ShortcutSettings; label: string }[]
                  ).map((item) => (
                    <div key={item.key} className="flex items-center justify-between gap-3">
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {item.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => setRecordingShortcutKey(item.key)}
                        onKeyDown={(e) => {
                          if (recordingShortcutKey !== item.key) return;
                          e.preventDefault();
                          const combo = formatKeyComboEvent(e);
                          if (combo) {
                            updateSettings((prev) => ({
                              ...prev,
                              app: {
                                ...prev.app,
                                shortcuts: { ...prev.app.shortcuts, [item.key]: combo },
                              },
                            }));
                            setRecordingShortcutKey(null);
                          }
                        }}
                        className="h-8 min-w-[160px] rounded-xl border px-3 text-xs font-semibold"
                        style={{
                          borderColor:
                            recordingShortcutKey === item.key
                              ? 'var(--accent)'
                              : 'var(--border-strong)',
                          backgroundColor: 'var(--bg-surface)',
                        }}
                      >
                        {recordingShortcutKey === item.key
                          ? 'Pressione teclas...'
                          : settings.app.shortcuts[item.key]}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* TAB 4: INTERFACE, THEMES, SCALE, EFFECTS & NOTIFICATIONS */}
            {activeTab === 'interface' && (
              <>
                <div>
                  <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Tema Visual
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        updateSettings((prev) => ({
                          ...prev,
                          interface: { ...prev.interface, theme: 'dark' },
                        }))
                      }
                      className="rounded-2xl border p-4 text-left transition-all"
                      style={{
                        borderColor:
                          settings.interface.theme === 'dark'
                            ? 'var(--accent)'
                            : 'var(--border-hairline)',
                        backgroundColor: '#0e1015',
                        color: '#f4f6fa',
                      }}
                    >
                      <div className="text-sm font-semibold">Tema Escuro (Obsidian)</div>
                      <div className="mt-1 text-xs text-slate-400">
                        Contraste profundo e elegante para longas sessões
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        updateSettings((prev) => ({
                          ...prev,
                          interface: { ...prev.interface, theme: 'light' },
                        }))
                      }
                      className="rounded-2xl border p-4 text-left transition-all"
                      style={{
                        borderColor:
                          settings.interface.theme === 'light'
                            ? 'var(--accent)'
                            : 'var(--border-hairline)',
                        backgroundColor: '#ffffff',
                        color: '#0f172a',
                      }}
                    >
                      <div className="text-sm font-semibold">Tema Claro (Alabaster)</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Superfícies claras suaves e tipografia de alta definição
                      </div>
                    </button>
                  </div>
                </div>

                {/* UI Scale */}
                <div
                  className="rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="mb-2 flex justify-between text-xs font-semibold">
                    <span>Escala da Interface</span>
                    <span className="tabular-nums">
                      {Math.round(settings.interface.uiScale * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={85}
                    max={120}
                    step={5}
                    value={Math.round(settings.interface.uiScale * 100)}
                    onChange={(e) =>
                      updateSettings((prev) => ({
                        ...prev,
                        interface: {
                          ...prev.interface,
                          uiScale: Number(e.target.value) / 100,
                        },
                      }))
                    }
                    className="aether-range w-full"
                  />
                </div>

                {/* Visual Effects */}
                <div
                  className="space-y-3.5 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold">Efeitos Translúcidos (Frosted Glass)</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Desfoque espacial suave em painéis e modais
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.interface.glassEffects}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          interface: { ...prev.interface, glassEffects: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>

                  <div
                    className="flex items-center justify-between border-t pt-3"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <div>
                      <div className="text-xs font-semibold">Animações Fluídas</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Transições naturais aceleradas por GPU
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.interface.smoothAnimations}
                      onChange={(e) =>
                        updateSettings((prev) => ({
                          ...prev,
                          interface: { ...prev.interface, smoothAnimations: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </div>
                </div>

                {/* Notifications */}
                <div
                  className="space-y-3.5 rounded-2xl border p-4"
                  style={{
                    borderColor: 'var(--border-hairline)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <div className="text-xs font-semibold">Notificações & Sons</div>

                  {(
                    [
                      { key: 'soundEnabled', label: 'Sons sutis da interface' },
                      { key: 'mentionAlerts', label: 'Alertas quando você for @mencionado' },
                      { key: 'joinLeaveSounds', label: 'Sons de entrada e saída nas salas' },
                      { key: 'desktopNotifications', label: 'Notificações do sistema operacional' },
                    ] as const
                  ).map((n) => (
                    <div key={n.key} className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {n.label}
                      </span>
                      <input
                        type="checkbox"
                        checked={settings.interface.notifications[n.key]}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          if (
                            n.key === 'desktopNotifications' &&
                            checked &&
                            'Notification' in window &&
                            Notification.permission === 'default'
                          ) {
                            void Notification.requestPermission();
                          }
                          updateSettings((prev) => ({
                            ...prev,
                            interface: {
                              ...prev.interface,
                              notifications: {
                                ...prev.interface.notifications,
                                [n.key]: checked,
                              },
                            },
                          }));
                        }}
                        className="h-4 w-4 accent-blue-600"
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

