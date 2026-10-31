#!/usr/bin/env bash
# ==============================================================================
# AETHER — BOOTSTRAP AUTOMATIZADO PARA ORACLE CLOUD ALWAYS FREE (24/7 GRATUITO)
# Compatível com Ubuntu 22.04 / 24.04 LTS (ARM64 Ampere A1 e AMD64 x86_64)
#
# Uso:
#   chmod +x deploy/bootstrap-oracle-free.sh
#   sudo PUBLIC_DOMAIN="aether.seudominio.com" \
#        DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/aether?sslmode=require" \
#        ./deploy/bootstrap-oracle-free.sh
# ==============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERRO] Execute este script com sudo (ex.: sudo ./deploy/bootstrap-oracle-free.sh)."
  exit 1
fi

echo "==> [1/6] Instalando utilitários de sistema e Docker Engine..."
apt-get update -y
apt-get install -y ca-certificates curl gnupg openssl iptables-persistent

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "==> [2/6] Otimizando buffers de rede UDP do Kernel Linux para WebRTC 1440p @ 75 FPS..."
cat >/etc/sysctl.d/99-aether-webrtc.conf <<'EOF'
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.core.rmem_default=2097152
net.core.wmem_default=2097152
EOF
sysctl --system >/dev/null

echo "==> [3/6] Liberando portas HTTP/HTTPS, STUN/TURN e WebRTC UDP no iptables da Oracle Cloud..."
# Imagens Ubuntu na Oracle Cloud possuem uma regra padrão REJECT no INPUT; inserimos antes dela:
iptables -I INPUT 1 -p tcp -m multiport --dports 80,443,3478 -j ACCEPT
iptables -I INPUT 1 -p udp -m multiport --dports 443,3478 -j ACCEPT
iptables -I INPUT 1 -p udp --dport 40000:40400 -j ACCEPT
iptables -I INPUT 1 -p tcp --dport 40000:40400 -j ACCEPT
iptables -I INPUT 1 -p udp --dport 49152:49300 -j ACCEPT
netfilter-persistent save

echo "==> [4/6] Detectando IPv4 público da instância..."
DETECTED_IP="${MEDIASOUP_ANNOUNCED_IP:-$(curl -4 -fsSL https://api.ipify.org)}"
DOMAIN="${PUBLIC_DOMAIN:-}"

if [[ ! -f .env.production ]]; then
  if [[ -z "${DOMAIN}" ]]; then
    echo "[ERRO] Defina PUBLIC_DOMAIN (ex.: PUBLIC_DOMAIN=aether.seudominio.com) ou crie .env.production antes de prosseguir."
    exit 1
  fi

  echo "==> [5/6] Gerando .env.production com chaves criptográficas de 384 bits (openssl rand -hex 48)..."
  JWT_ACCESS="$(openssl rand -hex 48)"
  JWT_REFRESH="$(openssl rand -hex 48)"
  PEPPER="$(openssl rand -hex 48)"
  DATA_KEY="$(openssl rand -hex 48)"
  TURN_SECRET="$(openssl rand -hex 32)"
  PG_LOCAL_PASS="$(openssl rand -hex 24)"

  cat >.env.production <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=3001

PUBLIC_DOMAIN=${DOMAIN}
PUBLIC_URL=https://${DOMAIN}

JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_REFRESH_SECRET=${JWT_REFRESH}
PASSWORD_PEPPER=${PEPPER}
DATA_ENCRYPTION_KEY=${DATA_KEY}

POSTGRES_USER=aether
POSTGRES_PASSWORD=${PG_LOCAL_PASS}
POSTGRES_DB=aether
DATABASE_URL=${DATABASE_URL:-postgresql://aether:${PG_LOCAL_PASS}@postgres:5432/aether}
DATABASE_SSL=${DATABASE_SSL:-$(if [[ -n "${DATABASE_URL:-}" ]]; then echo "true"; else echo "false"; fi)}

REDIS_URL=redis://redis:6379

MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=${DETECTED_IP}
MEDIASOUP_MIN_PORT=40000
MEDIASOUP_MAX_PORT=40400
MEDIASOUP_WORKERS=4

STUN_URLS=stun:stun.l.google.com:19302,stun:${DOMAIN}:3478
TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp
TURN_STATIC_AUTH_SECRET=${TURN_SECRET}

S3_BUCKET=${S3_BUCKET:-}
S3_REGION=${S3_REGION:-auto}
S3_ENDPOINT=${S3_ENDPOINT:-}
S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-}
S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-}
S3_PUBLIC_BASE_URL=${S3_PUBLIC_BASE_URL:-}
DESKTOP_INSTALLER_URL=${DESKTOP_INSTALLER_URL:-}
EOF
  chmod 600 .env.production
else
  echo "==> [5/6] .env.production existente detectado — preservando chaves e segredos."
fi

COMPOSE_FILE="docker-compose.production.yml"
if grep -q "neon.tech\|supabase.co" .env.production 2>/dev/null; then
  COMPOSE_FILE="docker-compose.free-cloud.yml"
fi

echo "==> [6/6] Compilando e iniciando Aether 24/7 (${COMPOSE_FILE})..."
docker compose --env-file .env.production -f "${COMPOSE_FILE}" up -d --build

echo ""
echo "=============================================================================="
echo " AETHER ONLINE 24/7 ATIVO COM SUCESSO!"
echo " Portal & Web App : https://${DOMAIN:-$(grep '^PUBLIC_DOMAIN=' .env.production | cut -d= -f2)}"
echo " IP SFU WebRTC    : ${DETECTED_IP} (UDP 40000-40400)"
echo " Lembre-se de liberar no Security List (Painel Oracle Cloud VCN):"
echo "   - TCP: 80, 443, 3478, 40000-40400"
echo "   - UDP: 443, 3478, 40000-40400, 49152-49300"
echo "=============================================================================="

