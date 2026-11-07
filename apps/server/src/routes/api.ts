import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AdminBanUserInputSchema,
  AdminClaimOwnerInputSchema,
  AdminUpdateRoleInputSchema,
  CreateRoomInputSchema,
  hasRoleAtLeast,
  LoginInputSchema,
  RegisterInputSchema,
  ROLE_RANK,
  UpdateProfileInputSchema,
  UserSettingsSchema,
  type AuthUser,
} from '@aether/shared';
import { config } from '../config.js';
import type { AppDatabase } from '../db/Database.js';
import {
  authGuard,
  hashOpaqueToken,
  hashPassword,
  issueWsTicket,
  needsPasswordRehash,
  parseCookieValue,
  pickAvatarColor,
  REFRESH_COOKIE_NAME,
  serializeClearRefreshCookie,
  serializeRefreshCookie,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyAdminMasterKey,
  verifyDummyPassword,
  verifyPassword,
  verifyRefreshToken,
} from '../security.js';
import type { StorageService } from '../storage/StorageService.js';
import type { RealtimeGateway } from '../ws/RealtimeGateway.js';

function isSecureRequest(req: FastifyRequest): boolean {
  if (config.isProduction) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  return req.protocol === 'https';
}

async function requireAuthUser(req: FastifyRequest, reply: FastifyReply, db: AppDatabase): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Não autenticado' });
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifyAccessToken(token);
  if (!payload) {
    reply.code(401).send({ error: 'Sessão inválida ou expirada' });
    return null;
  }
  const row = await db.findUserRowById(payload.sub);
  if (!row) {
    reply.code(401).send({ error: 'Conta não encontrada' });
    return null;
  }
  if (Boolean(row.is_banned)) {
    reply.code(403).send({
      error: row.ban_reason
        ? `Conta suspensa: ${row.ban_reason}`
        : 'Sua conta foi suspensa pela administração.',
    });
    return null;
  }
  return db.enrichAuthUser(row);
}

async function issueSessionTokens(
  db: AppDatabase,
  userId: string,
  username: string,
  existingFamilyId?: string
) {
  const accessToken = signAccessToken(userId, username);
  const refreshId = crypto.randomUUID();
  const familyId = existingFamilyId || refreshId;
  const refreshToken = signRefreshToken(userId, refreshId, familyId);
  const tokenHash = hashOpaqueToken(refreshToken);
  const expiresAt = new Date(Date.now() + config.jwt.refreshExpiresInSec * 1000).toISOString();

  await db.storeRefreshToken({
    id: refreshId,
    userId,
    tokenHash,
    familyId,
    expiresAtIso: expiresAt,
  });

  return { accessToken, refreshToken };
}

function findDesktopInstallerFile(): { fullPath: string; filename: string; sizeBytes: number } | null {
  if (!fs.existsSync(config.desktopReleaseDir)) return null;
  const entries = fs.readdirSync(config.desktopReleaseDir);
  const exe = entries
    .filter((f) => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('unins'))
    .sort()
    .reverse()[0];
  if (!exe) return null;
  const fullPath = path.join(config.desktopReleaseDir, exe);
  const stat = fs.statSync(fullPath);
  return { fullPath, filename: exe, sizeBytes: stat.size };
}

const DEFAULT_GITHUB_INSTALLER_URL =
  'https://github.com/homepython/aether-platform/releases/download/v1.1.0/Aether-Setup-1.1.0.exe';

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    storage: StorageService;
    gateway: RealtimeGateway;
  }
): Promise<void> {
  const { db, storage, gateway } = deps;

  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'aether-realtime-server',
      version: config.appVersion,
      maxUploadBytes: config.maxUploadBytes,
      database: db.isPostgres ? 'postgresql' : 'sqlite-wal',
      cluster: config.redisUrl ? 'redis-multi-node' : 'single-node',
      onlineConnections: gateway.getOnlineCount(),
      timestamp: new Date().toISOString(),
    };
  });

  // Auth: Register
  app.post('/api/auth/register', async (req, reply) => {
    const rl = authGuard.checkRateLimit(`reg:${req.ip}`, 10, 10 * 60 * 1000);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply.code(429).send({
        error: `Muitas tentativas de cadastro. Aguarde ${rl.retryAfterSec}s e tente novamente.`,
      });
    }

    const parsed = RegisterInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || 'Dados inválidos para cadastro',
      });
    }
    const { username, displayName, email, password } = parsed.data;
    const conflict = await db.checkUserConflict(username, email);
    if (conflict === 'username') {
      return reply.code(409).send({ error: 'Este nome de usuário já está em uso' });
    }
    if (conflict === 'email') {
      return reply.code(409).send({ error: 'Este e-mail já está cadastrado' });
    }

    const passwordHash = await hashPassword(password);
    const user = await db.createUser({
      username,
      displayName,
      email,
      passwordHash,
      avatarColor: pickAvatarColor(username),
    });

    const tokens = await issueSessionTokens(db, user.id, user.username);
    reply.header(
      'Set-Cookie',
      serializeRefreshCookie(tokens.refreshToken, config.jwt.refreshExpiresInSec, isSecureRequest(req))
    );
    return reply.code(201).send({ user, ...tokens });
  });

  // Auth: Login
  app.post('/api/auth/login', async (req, reply) => {
    const rl = authGuard.checkRateLimit(`login:${req.ip}`, 20, 5 * 60 * 1000);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply.code(429).send({
        error: `Muitas tentativas de login. Aguarde ${rl.retryAfterSec}s.`,
      });
    }

    const parsed = LoginInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || 'Credenciais inválidas',
      });
    }

    const lock = authGuard.checkLoginLockout(req.ip, parsed.data.identifier);
    if (lock.locked) {
      reply.header('Retry-After', String(lock.retryAfterSec));
      return reply.code(429).send({
        error: `Conta temporariamente protegida contra força bruta. Tente novamente em ${lock.retryAfterSec}s.`,
      });
    }

    const row = await db.findUserRowByIdentifier(parsed.data.identifier);
    if (!row) {
      await verifyDummyPassword(parsed.data.password);
      authGuard.recordLoginFailure(req.ip, parsed.data.identifier);
      return reply.code(401).send({ error: 'Usuário ou senha incorretos' });
    }

    const ok = await verifyPassword(parsed.data.password, row.password_hash);
    if (!ok) {
      authGuard.recordLoginFailure(req.ip, parsed.data.identifier);
      return reply.code(401).send({ error: 'Usuário ou senha incorretos' });
    }

    authGuard.clearLoginFailures(req.ip, parsed.data.identifier);

    if (Boolean(row.is_banned)) {
      return reply.code(403).send({
        error: row.ban_reason
          ? `Conta suspensa: ${row.ban_reason}`
          : 'Sua conta foi suspensa pela administração.',
      });
    }

    if (needsPasswordRehash(row.password_hash)) {
      const upgradedHash = await hashPassword(parsed.data.password);
      await db.updateUserPasswordHash(row.id, upgradedHash);
    }

    const user = await db.enrichAuthUser(row);
    const tokens = await issueSessionTokens(db, user.id, user.username);
    reply.header(
      'Set-Cookie',
      serializeRefreshCookie(tokens.refreshToken, config.jwt.refreshExpiresInSec, isSecureRequest(req))
    );
    return { user, ...tokens };
  });

  // Auth: Refresh (supports HttpOnly Cookie on Web + DPAPI Encrypted Vault on Desktop)
  app.post('/api/auth/refresh', async (req, reply) => {
    const rl = authGuard.checkRateLimit(`refresh:${req.ip}`, 30, 5 * 60 * 1000);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply.code(429).send({ error: 'Limite de renovação excedido' });
    }

    const body = (req.body || {}) as { refreshToken?: string };
    const cookieToken = parseCookieValue(req.headers.cookie, REFRESH_COOKIE_NAME);
    const rawRefreshToken = body.refreshToken || cookieToken;

    if (!rawRefreshToken) {
      return reply.code(400).send({ error: 'Refresh token obrigatório' });
    }
    const payload = verifyRefreshToken(rawRefreshToken);
    if (!payload) {
      reply.header('Set-Cookie', serializeClearRefreshCookie(isSecureRequest(req)));
      return reply.code(401).send({ error: 'Refresh token inválido ou expirado' });
    }

    const presentedHash = hashOpaqueToken(rawRefreshToken);
    const consumed = await db.consumeRefreshToken(payload.jti, payload.sub, presentedHash);
    if (!consumed.ok) {
      reply.header('Set-Cookie', serializeClearRefreshCookie(isSecureRequest(req)));
      return reply.code(401).send({
        error: consumed.replayDetected
          ? 'Tentativa de reutilização de sessão detectada — todas as sessões foram revogadas por segurança'
          : 'Sessão encerrada',
      });
    }

    const row = await db.findUserRowById(payload.sub);
    if (!row) {
      reply.header('Set-Cookie', serializeClearRefreshCookie(isSecureRequest(req)));
      return reply.code(401).send({ error: 'Usuário não encontrado' });
    }
    if (Boolean(row.is_banned)) {
      await db.revokeAllUserRefreshTokens(row.id);
      reply.header('Set-Cookie', serializeClearRefreshCookie(isSecureRequest(req)));
      return reply.code(403).send({
        error: row.ban_reason
          ? `Conta suspensa: ${row.ban_reason}`
          : 'Sua conta foi suspensa pela administração.',
      });
    }
    const user = await db.enrichAuthUser(row);
    const tokens = await issueSessionTokens(db, user.id, user.username, consumed.familyId);
    reply.header(
      'Set-Cookie',
      serializeRefreshCookie(tokens.refreshToken, config.jwt.refreshExpiresInSec, isSecureRequest(req))
    );
    return { user, ...tokens };
  });

  // Auth: Logout
  app.post('/api/auth/logout', async (req, reply) => {
    const body = (req.body || {}) as { refreshToken?: string };
    const cookieToken = parseCookieValue(req.headers.cookie, REFRESH_COOKIE_NAME);
    const rawRefreshToken = body.refreshToken || cookieToken;
    if (rawRefreshToken) {
      const payload = verifyRefreshToken(rawRefreshToken);
      if (payload) {
        await db.revokeRefreshToken(payload.jti);
      }
    }
    reply.header('Set-Cookie', serializeClearRefreshCookie(isSecureRequest(req)));
    return { ok: true };
  });

  // Auth: Ephemeral Single-Use WebSocket Ticket (30s TTL — prevents JWT in WS URLs)
  app.post('/api/auth/ws-ticket', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const ticket = issueWsTicket(user.id, 30_000);
    return { ticket, expiresInSec: 30 };
  });

  // Auth: Current User
  app.get('/api/auth/me', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    return { user };
  });

  // User Settings Persistence
  app.put('/api/users/me/settings', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const parsed = UserSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Formato de configurações inválido' });
    }
    const saved = await db.updateUserSettings(user.id, parsed.data);
    return { settings: saved };
  });

  // Editable User Profile (DisplayName, Nickname with 3x/24h Guard, Bio, AvatarColor, AvatarUrl, Presence)
  app.patch('/api/users/me/profile', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const parsed = UpdateProfileInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || 'Dados de perfil inválidos',
      });
    }

    try {
      const updated = await db.updateUserProfile(user.id, parsed.data);
      if (!updated) {
        return reply.code(404).send({ error: 'Conta não encontrada' });
      }
      await gateway.syncUserProfileEverywhere(updated);
      return { user: updated };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const lockedUntil = (err as { lockedUntil?: string })?.lockedUntil ?? null;
      const message = err instanceof Error ? err.message : 'Erro ao atualizar perfil';
      if (code === 'NICKNAME_RATE_LIMIT') {
        return reply.code(429).send({ error: message, code, lockedUntil });
      }
      if (code === 'USERNAME_TAKEN') {
        return reply.code(409).send({ error: message, code });
      }
      return reply.code(400).send({ error: message });
    }
  });

  // User Avatar Upload (Static PNG/JPEG/WebP + Full Multi-Frame Animated GIF / WebP Preservation)
  app.post(
    '/api/users/me/avatar',
    { bodyLimit: config.maxAvatarBytes + 2 * 1024 * 1024 },
    async (req, reply) => {
      const user = await requireAuthUser(req, reply, db);
      if (!user) return;

      const data = await req.file({ limits: { fileSize: config.maxAvatarBytes } });
      if (!data) {
        return reply.code(400).send({ error: 'Nenhuma imagem de perfil enviada' });
      }

      const mimeType = (data.mimetype || '').toLowerCase();
      if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mimeType)) {
        data.file.resume();
        return reply.code(400).send({
          error: 'Formato não suportado. Use PNG, JPG, WebP ou GIF animado.',
        });
      }

      try {
        const stored = await storage.storeStream({
          stream: data.file,
          originalFilename: data.filename || 'avatar',
          mimeType,
          maxBytes: config.maxAvatarBytes,
        });

        if (!stored.width || !stored.height) {
          const local = storage.resolveLocalFilePath(stored.storageKey);
          if (local) await fs.promises.unlink(local).catch(() => {});
          return reply.code(400).send({
            error: 'Arquivo de imagem inválido ou corrompido.',
          });
        }

        const updated = await db.updateUserProfile(user.id, { avatarUrl: stored.urlPath });
        if (!updated) {
          return reply.code(404).send({ error: 'Conta não encontrada' });
        }

        await gateway.syncUserProfileEverywhere(updated);
        return { user: updated, avatarUrl: stored.urlPath };
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const message = err instanceof Error ? err.message : 'Falha ao enviar foto de perfil';
        if (code === 'PAYLOAD_TOO_LARGE') {
          return reply.code(413).send({ error: message });
        }
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Public User Card Lookup by Username
  app.get('/api/users/:username/profile', async (req, reply) => {
    const authUser = await requireAuthUser(req, reply, db);
    if (!authUser) return;
    const { username } = req.params as { username: string };
    const clean = decodeURIComponent(username).trim().replace(/^@+/, '').toLowerCase();
    const matches = await db.findUsersByUsernames([clean]);
    if (!matches[0]) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }
    return { user: matches[0] };
  });

  // Rooms List & Creation
  app.get('/api/rooms', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const rooms = await gateway.buildRoomSummaries();
    return { rooms };
  });

  app.post('/api/rooms', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const parsed = CreateRoomInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || 'Dados da sala inválidos',
      });
    }
    const rawPassword = parsed.data.password?.trim() || '';
    const passwordHash = rawPassword.length > 0 ? await hashPassword(rawPassword) : null;

    const roomRow = await db.createRoom({
      name: parsed.data.name,
      description: parsed.data.description,
      isPrivate: parsed.data.isPrivate,
      passwordHash,
      ownerId: user.id,
    });

    await gateway.broadcastLobbyRoomsUpdate();
    return reply.code(201).send({ room: gateway.mapRoomSummary(roomRow) });
  });

  app.delete('/api/rooms/:roomId', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const { roomId } = req.params as { roomId: string };
    const room = await db.getRoomById(roomId);
    if (!room) {
      return reply.code(404).send({ error: 'Sala não encontrada' });
    }
    const isStaffAdmin = hasRoleAtLeast(user.role, 'admin');
    if (room.owner_id !== user.id && !isStaffAdmin) {
      return reply
        .code(403)
        .send({ error: 'Somente o criador ou um administrador pode excluir esta sala' });
    }
    gateway.evictRoomParticipantsOnDelete(roomId, room.name, user.displayName);
    await db.deleteRoom(roomId);
    if (room.owner_id !== user.id) {
      await db.recordAdminAuditLog({
        actorId: user.id,
        actorRole: user.role,
        action: 'room:delete',
        details: `Sala "${room.name}" excluída pela administração`,
      });
    }
    await gateway.broadcastLobbyRoomsUpdate();
    return { deleted: true };
  });

  // Administration & RBAC Routes (Cloud-Authoritative across any PC)
  app.post('/api/admin/claim-owner', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;

    const rl = authGuard.checkRateLimit(`claim-owner:${req.ip}:${user.id}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply.code(429).send({
        error: `Muitas tentativas de verificação da chave mestre. Aguarde ${rl.retryAfterSec}s.`,
      });
    }

    const parsed = AdminClaimOwnerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || 'Formato da chave mestre inválido',
      });
    }

    if (!verifyAdminMasterKey(parsed.data.masterKey)) {
      return reply.code(403).send({ error: 'Chave mestre administrativa incorreta' });
    }

    const updated = await db.setUserRole(user.id, 'owner');
    if (!updated) {
      return reply.code(404).send({ error: 'Conta não encontrada' });
    }

    await db.recordAdminAuditLog({
      actorId: updated.id,
      actorRole: 'owner',
      action: 'role:claim_owner',
      targetUserId: updated.id,
      targetUsername: updated.username,
      details: 'Credencial Fundador (Owner) ativada com Chave Mestre criptográfica',
    });

    await gateway.syncUserRoleEverywhere(updated);
    return { user: updated };
  });

  // Accessible to Moderator, Admin, and Owner so Moderators have full Moderation Panel visibility
  app.get('/api/admin/users', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'moderator')) {
      return reply.code(403).send({ error: 'Acesso restrito à equipe de moderação e administração' });
    }
    const users = await db.listAllUsersForAdmin(gateway.getOnlineUserMap());
    return { users };
  });

  app.patch('/api/admin/users/:userId/role', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'admin')) {
      return reply.code(403).send({ error: 'Somente Administradores ou o Fundador podem alterar cargos' });
    }

    const { userId } = req.params as { userId: string };
    if (userId === user.id) {
      return reply.code(400).send({ error: 'Você não pode alterar seu próprio cargo' });
    }

    const parsed = AdminUpdateRoleInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Cargo informado é inválido' });
    }

    const targetRow = await db.findUserRowById(userId);
    if (!targetRow) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }

    const targetCurrentRole = db.parseUserRole(targetRow.role);
    if (targetCurrentRole === 'owner') {
      return reply.code(403).send({ error: 'O cargo de Fundador é soberano e não pode ser alterado' });
    }

    if (
      (parsed.data.role === 'admin' || targetCurrentRole === 'admin') &&
      user.role !== 'owner'
    ) {
      return reply.code(403).send({
        error: 'Somente o Fundador pode promover ou revogar Administradores',
      });
    }

    const updated = await db.setUserRole(userId, parsed.data.role);
    if (!updated) {
      return reply.code(404).send({ error: 'Falha ao atualizar cargo do usuário' });
    }

    await db.recordAdminAuditLog({
      actorId: user.id,
      actorRole: user.role,
      action: 'role:update',
      targetUserId: updated.id,
      targetUsername: updated.username,
      details: `Cargo alterado de "${targetCurrentRole}" para "${parsed.data.role}"`,
    });

    await gateway.syncUserRoleEverywhere(updated);
    return { user: updated };
  });

  app.post('/api/admin/users/:userId/ban', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'admin')) {
      return reply.code(403).send({ error: 'Somente Administradores ou o Fundador podem suspender contas' });
    }

    const { userId } = req.params as { userId: string };
    if (userId === user.id) {
      return reply.code(400).send({ error: 'Você não pode suspender sua própria conta' });
    }

    const parsed = AdminBanUserInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Parâmetros de suspensão inválidos' });
    }

    const targetRow = await db.findUserRowById(userId);
    if (!targetRow) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }

    const targetRole = db.parseUserRole(targetRow.role);
    if (targetRole === 'owner' || (user.role !== 'owner' && ROLE_RANK[user.role] <= ROLE_RANK[targetRole])) {
      return reply.code(403).send({
        error: 'Hierarquia insuficiente para moderar esta conta',
      });
    }

    const cleanReason = parsed.data.reason?.trim() || 'Violação das diretrizes da plataforma';
    await db.setUserBanState(userId, parsed.data.banned, parsed.data.banned ? cleanReason : null);

    if (parsed.data.banned) {
      await db.revokeAllUserRefreshTokens(userId);
      gateway.disconnectBannedUser(userId, cleanReason);
    }

    await db.recordAdminAuditLog({
      actorId: user.id,
      actorRole: user.role,
      action: parsed.data.banned ? 'account:ban' : 'account:unban',
      targetUserId: targetRow.id,
      targetUsername: targetRow.username,
      details: parsed.data.banned
        ? `Conta suspensa (${cleanReason})`
        : 'Suspensão de conta revogada',
    });

    return { ok: true, banned: parsed.data.banned };
  });

  app.get('/api/admin/audit-logs', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'moderator')) {
      return reply.code(403).send({ error: 'Acesso restrito à equipe de moderação e administração' });
    }
    const logs = await db.listAdminAuditLogs(100);
    return { logs };
  });

  // Zero-RAM Streaming File & Clipboard Upload (up to 550 MB)
  app.post(
    '/api/uploads',
    { bodyLimit: config.maxUploadBytes + 4 * 1024 * 1024 },
    async (req, reply) => {
      const user = await requireAuthUser(req, reply, db);
      if (!user) return;

      const data = await req.file({ limits: { fileSize: config.maxUploadBytes } });
      if (!data) {
        return reply.code(400).send({ error: 'Nenhum arquivo enviado' });
      }

      const mimeType = data.mimetype || 'application/octet-stream';
      try {
        const stored = await storage.storeStream({
          stream: data.file,
          originalFilename: data.filename || 'upload',
          mimeType,
          maxBytes: config.maxUploadBytes,
        });

        const attachment = await db.createAttachment({
          uploaderId: user.id,
          roomId: null,
          filename: data.filename || 'arquivo',
          mimeType,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          urlPath: stored.urlPath,
          isImage: stored.isImage,
          width: stored.width,
          height: stored.height,
        });

        return reply.code(201).send({ attachment });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const message = err instanceof Error ? err.message : 'Falha ao processar upload';
        if (code === 'PAYLOAD_TOO_LARGE') {
          return reply.code(413).send({ error: message });
        }
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Serve uploaded files securely with HTTP Range support for 500 MB video/audio streaming
  app.get('/uploads/:storageKey', async (req, reply) => {
    const { storageKey } = req.params as { storageKey: string };
    const decoded = decodeURIComponent(storageKey);
    const localPath = storage.resolveLocalFilePath(decoded);
    if (!localPath) {
      return reply.code(404).send({ error: 'Arquivo não encontrado' });
    }

    const stat = await fs.promises.stat(localPath);
    const totalSize = stat.size;

    const ext = path.extname(localPath).toLowerCase();
    const mimeByExt: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.avif': 'image/avif',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain; charset=utf-8',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.wav': 'audio/wav',
      '.zip': 'application/zip',
      '.7z': 'application/x-7z-compressed',
      '.rar': 'application/vnd.rar',
    };
    const contentType = mimeByExt[ext] || 'application/octet-stream';
    const isSafeInline =
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === 'application/pdf';

    reply.header('Content-Type', contentType);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (!isSafeInline) {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(localPath)}"`);
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader && typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(startStr, 10);
      const end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < totalSize) {
        const chunkSize = end - start + 1;
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        reply.header('Content-Length', String(chunkSize));
        return reply.send(fs.createReadStream(localPath, { start, end }));
      }
    }

    reply.header('Content-Length', String(totalSize));
    return reply.send(fs.createReadStream(localPath));
  });

  // Official Desktop Installer Metadata & Download
  app.get('/api/releases/info', async () => {
    const externalUrl = process.env.DESKTOP_INSTALLER_URL || '';
    const installer = findDesktopInstallerFile();
    return {
      version: config.appVersion,
      platform: 'Windows 10 / 11 (64-bit)',
      available: true,
      filename: installer?.filename || `Aether-Setup-${config.appVersion}.exe`,
      sizeBytes: installer?.sizeBytes || null,
      downloadUrl: externalUrl || (installer ? '/api/releases/desktop/windows' : DEFAULT_GITHUB_INSTALLER_URL),
    };
  });

  app.get('/api/releases/desktop/windows', async (_req, reply) => {
    if (process.env.DESKTOP_INSTALLER_URL) {
      return reply.redirect(process.env.DESKTOP_INSTALLER_URL);
    }
    const installer = findDesktopInstallerFile();
    if (!installer) {
      return reply.redirect(DEFAULT_GITHUB_INSTALLER_URL);
    }
    reply.header('Content-Type', 'application/vnd.microsoft.portable-executable');
    reply.header('Content-Length', String(installer.sizeBytes));
    reply.header('Content-Disposition', `attachment; filename="${installer.filename}"`);
    return reply.send(fs.createReadStream(installer.fullPath));
  });
}
