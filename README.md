# Aether — Plataforma Real-Time de Voz, Chat & Transmissão Ultra-HD

**Aether** é uma plataforma completa de comunicação em tempo real projetada para operação 24/7 na nuvem com **100% de paridade funcional entre Web e Desktop** — unindo **Voz cristalina com DSP Neural**, **Chat rico instantâneo**, **Transmissão ao Vivo Ultra-HD (`720p` / `1080p` / `1440p` em `30` / `60` / `75` FPS)**, **Portal Web Oficial + Web App** e **Aplicativo Desktop nativo para Windows** com **Overlay In-Game sem perda de foco**, **Cofre Criptográfico Windows DPAPI** e instalador NSIS (`Aether-Setup-1.0.0.exe`).

---

## Garantias Arquiteturais & Segurança de Produção

1. **Paridade 100% Web = Desktop (`Aether.exe`)**:
   - Pipeline unificado de publicação SFU sequencial (`sfu:produceStreamTrack` p/ Vídeo + Áudio Estéreo antes de `stream:start`), eliminando qualquer bloqueio na fila interna do `mediasoup-client` quando o Desktop publica vídeo junto ao áudio nativo WASAPI.
   - Protocolo seguro privilegiado `aether://app` empacotado no Electron (`standard`, `secure`, `supportFetchAPI`, `stream`) garantindo carregamento nativo de `AudioWorklet` e `RNNoise SIMD WebAssembly` dentro de `app.asar`.
   - Captura nativa Windows Graphics Capture (`WGC`) via `setDisplayMediaRequestHandler` com fallback automático de codec de hardware (`H.264 High L5.2 640034` → `H.264 Baseline 42e034` → `AV1/VP9/VP8`).
2. **Segurança Criptográfica de Login, Senhas & Sessões**:
   - **Senhas**: Hashing `scrypt` reforçado (`N = 32768`, `r = 8`, `p = 1`, `64 bytes`) + **Salt aleatório exclusivo de 32 bytes (`256 bits`)** por usuário + **`PASSWORD_PEPPER`** de servidor (`HMAC-SHA256`) + mitigação anti-enumeração em tempo constante (`timingSafeEqual`).
   - **Dados Sensíveis em Repouso**: E-mails armazenados criptografados com **`AES-256-GCM`** autenticado (`enc1$iv$tag$ciphertext`) + índice cego determinístico **`HMAC-SHA256`** (`email_lower`) para busca sem expor texto puro no banco.
   - **Sessões & Credenciais**: Access Token curto (`15 min`) mantido exclusivamente em memória RAM (zero `localStorage`); Refresh Token armazenado no banco apenas como hash `SHA-256` com **detecção de Token Replay** (reutilização revoga toda a família de sessão); Cookie `HttpOnly; Secure; SameSite=Strict` no navegador e **Cofre Nativo Windows DPAPI (`electron.safeStorage`)** no Desktop.
   - **WebSocket & Borda HTTP**: Autenticação `/ws` via **Ticket efêmero de uso único (`30s`)** (`POST /api/auth/ws-ticket`), Rate Limiter por IP/conta contra força bruta e cabeçalhos `CSP`, `HSTS`, `X-Frame-Options: DENY` e `X-Content-Type-Options: nosniff`.
3. **Zero Audio Ducking & Zero Eco de Voz**:
   - **Windows Core Audio (`aether-native-helper.exe`)**: `IAudioSessionControl2::SetDuckingPreference(TRUE)` + `AudioContext` duplos independentes (`voiceCtx` vs `streamCtx`) + Opus Estéreo CBR 320 kbps (`usedtx=0`).
   - **WASAPI Process Loopback**: Isola o áudio do `PID` do jogo ou exclui a árvore de processos do próprio Aether na captura de tela inteira (`0%` de retorno das vozes da sala).
4. **Qualidade Estrita Ultra-HD**:
   - Resoluções exclusivas: **`720p` (`1280×720`)**, **`1080p` (`1920×1080`)**, **`1440p` (`2560×1440`)**.
   - Taxas de quadros exclusivas: **`30` FPS**, **`60` FPS**, **`75` FPS**.

---

## Estrutura do Monorepo

```text
├── packages/
│   └── shared/                     # Schemas Zod, política StrongPassword, perfis 720p/1080p/1440p × 30/60/75 FPS e protocolo RPC/WS
├── apps/
│   ├── server/                     # Backend Fastify + Segurança (scrypt2/AES-256-GCM/WS Tickets) + SFU mediasoup + PostgreSQL SSL/SQLite
│   ├── web/                        # Portal Oficial + Web App (React 19, Zustand, Dual-Bus AudioEngine, Seletor de Servidor Online)
│   └── desktop/                    # Aplicativo Desktop Windows (Electron 34, Protocolo aether://app, Cofre DPAPI, WGC, Overlay In-Game)
│       └── native-helper/          # Companion C# (.NET 8): WASAPI Process Loopback, Anti-Ducking, Hooks Globais PTT
├── deploy/
│   ├── bootstrap-oracle-free.sh    # Script 1-comando para provisionar servidor 100% gratuito 24/7 na Oracle Cloud Always Free
│   ├── caddy/Caddyfile             # Reverse Proxy TLS automático (HTTPS + WSS HTTP/2 & HTTP/3)
│   └── coturn/turnserver.conf      # Servidor STUN/TURN com credenciais efêmeras HMAC-SHA1
├── release/
│   └── desktop/                    # Instalador compilado (Aether-Setup-1.0.0.exe) e binário empacotado (win-unpacked/Aether.exe)
├── tests/
│   └── platform.e2e.test.ts        # Suíte E2E real (Segurança Criptográfica, Replay Detection, WS Ticket, SFU Vídeo+Áudio 1440p@75fps)
├── docker-compose.free-cloud.yml   # Stack 100% gratuita 24/7 (Oracle Always Free + Neon.tech PostgreSQL + Cloudflare R2)
├── docker-compose.production.yml   # Stack auto-hospedada completa (com PostgreSQL e Redis locais em containers)
├── fly.toml                        # Manifesto alternativo PaaS Fly.io (HTTP/WSS + UDP WebRTC)
└── render.yaml                     # Blueprint alternativo Render.com
```

---

## Deploy Online 100% Gratuito 24/7 (Zero Dependência do Seu Computador)

Para manter Login, Registro, Banco de Dados, Salas, Chat, Voz e Transmissões (`1440p @ 75 FPS`) funcionando **24 horas por dia com o seu PC desligado** e **custo R$ 0,00/mês**, utilize a combinação **Always Free** abaixo:

### 1. Banco PostgreSQL Gerenciado Gratuito (Neon.tech)
1. Crie uma conta gratuita em **Neon.tech** (sem cartão de crédito) e crie um projeto `aether` na região mais próxima (ex.: `AWS São Paulo sa-east-1` ou `US East`).
2. Copie a string `DATABASE_URL` com TLS (`postgresql://usuario:senha@ep-xxx-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require`).
   - O driver `PostgresDriver` do Aether já ativa TLS automaticamente e possui *auto-retry* transparente caso o banco serverless esteja acordando de repouso (*cold start*).

### 2. Armazenamento S3 Gratuito p/ Imagens e Instalador (Cloudflare R2 — Opcional)
1. No painel da **Cloudflare**, ative o **R2** (10 GB gratuitos/mês e zero cobrança de banda de saída).
2. Crie um bucket `aether-media`, gere uma API Key S3 e anote `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` e `S3_PUBLIC_BASE_URL`.
3. Opcionalmente, envie `release/desktop/Aether-Setup-1.0.0.exe` para o **GitHub Releases** ou **Cloudflare R2** e defina a URL direta em `DESKTOP_INSTALLER_URL`.

### 3. Servidor SFU WebRTC + API + Web App 24/7 Gratuito (Oracle Cloud Always Free)
> **Por que Oracle Cloud Always Free?** Plataformas HTTP puras gratuitas bloqueiam portas **UDP**, indispensáveis para mídia WebRTC (`mediasoup` C++) sem atraso em `1440p @ 75 FPS`. O plano **Oracle Cloud Always Free** oferece gratuitamente de forma vitalícia uma máquina **`VM.Standard.A1.Flex` com 4 OCPUs Ampere, 24 GB de RAM, IPv4 público fixo e 10 TB/mês de tráfego**, suportando UDP nativo.

1. Crie uma instância **Ubuntu 24.04 LTS** (`VM.Standard.A1.Flex` — 4 OCPUs / 24 GB RAM) na Oracle Cloud.
2. Na **Security List (VCN)** do painel da Oracle Cloud, adicione *Ingress Rules* para `0.0.0.0/0`:
   - **TCP**: `80`, `443`, `3478`, `40000-40400`
   - **UDP**: `443`, `3478`, `40000-40400`, `49152-49300`
3. Aponte um registro DNS tipo **A** (ex.: `aether.seudominio.com` ou subdomínio gratuito DuckDNS / No-IP, com proxy laranja desligado / *DNS Only* para não filtrar UDP) para o **IPv4 público** da VM.
4. Conecte-se via SSH à VM, envie/clone o projeto e execute o **script automatizado de 1 comando**:

```bash
chmod +x deploy/bootstrap-oracle-free.sh
sudo PUBLIC_DOMAIN="aether.seudominio.com" \
     DATABASE_URL="postgresql://usuario:senha@ep-xxx-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require" \
     ./deploy/bootstrap-oracle-free.sh
```

O script configura automaticamente o Docker, ajusta os buffers UDP de 16 MB no Kernel Linux, abre as regras do `iptables` nativo da Oracle, gera chaves criptográficas exclusivas de 384 bits (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PASSWORD_PEPPER`, `DATA_ENCRYPTION_KEY`, `TURN_STATIC_AUTH_SECRET`), sobe o `docker-compose.free-cloud.yml` com `restart: unless-stopped` e emite o certificado HTTPS/WSS via Caddy.

### 4. Conectando o Aplicativo Desktop (`Aether.exe`) ao Servidor Online
Você pode conectar o executável Desktop ao servidor em nuvem de duas maneiras:
- **Diretamente na Tela de Login**: Clique no indicador **Online / Trocar servidor** no topo do card de Login e informe `https://aether.seudominio.com` (o status e a latência em `ms` são validados na hora).
- **Embutido de fábrica no Instalador `.exe`**: Ao compilar o instalador para distribuir aos seus usuários, defina a URL pública para que o `Aether.exe` já abra conectado à nuvem sem precisar configurar nada:

```powershell
$env:VITE_SERVER_URL="https://aether.seudominio.com"
$env:AETHER_SERVER_URL="https://aether.seudominio.com"
npm.cmd run dist:desktop
```

---

## Como Executar e Compilar Localmente

```powershell
# 1. Instalar dependências e compilar todos os pacotes (shared, server, web, desktop)
npm.cmd install
npm.cmd run build

# 2. Iniciar servidor local completo (http://localhost:3001)
npm.cmd run start

# 3. Gerar novo instalador Windows NSIS (release/desktop/Aether-Setup-1.0.0.exe)
npm.cmd run dist:desktop

# 4. Executar suíte automatizada End-to-End (Segurança + SFU Vídeo/Áudio + Chat + Nativo)
npx.cmd vitest run
```
