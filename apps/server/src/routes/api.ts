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
  return db.mapAuthUser(row);
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
      version: '1.0.0',
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
      // Constant-time scrypt execution prevents timing-based username/email enumeration
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

    // Transparently upgrade legacy password hashes to scrypt2 + pepper
    if (needsPasswordRehash(row.password_hash)) {
      const upgradedHash = await hashPassword(parsed.data.password);
      await db.updateUserPasswordHash(row.id, upgradedHash);
    }

    const user = db.mapAuthUser(row);
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
    const user = db.mapAuthUser(row);
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

  // User Profile Update
  app.patch('/api/users/me/profile', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    const body = (req.body || {}) as { displayName?: string; avatarUrl?: string | null };
    if (body.displayName !== undefined && (body.displayName.trim().length < 2 || body.displayName.trim().length > 40)) {
      return reply.code(400).send({ error: 'Nome de exibição deve ter entre 2 e 40 caracteres' });
    }
    const updated = await db.updateUserProfile(user.id, body);
    return { user: updated };
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

  app.get('/api/admin/users', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'admin')) {
      return reply.code(403).send({ error: 'Acesso restrito à administração' });
    }
    const users = await db.listAllUsersForAdmin(gateway.getOnlineUserMap());
    return { users };
  });

  app.patch('/api/admin/users/:userId/role', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;
    if (!hasRoleAtLeast(user.role, 'admin')) {
      return reply.code(403).send({ error: 'Acesso restrito à administração' });
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
      return reply.code(403).send({ error: 'Acesso restrito à administração' });
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
    if (!hasRoleAtLeast(user.role, 'admin')) {
      return reply.code(403).send({ error: 'Acesso restrito à administração' });
    }
    const logs = await db.listAdminAuditLogs(100);
    return { logs };
  });

  // File & Clipboard Image Upload
  app.post('/api/uploads', async (req, reply) => {
    const user = await requireAuthUser(req, reply, db);
    if (!user) return;

    const data = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!data) {
      return reply.code(400).send({ error: 'Nenhum arquivo enviado' });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of data.file) {
      total += chunk.length;
      if (total > config.maxUploadBytes) {
        return reply.code(413).send({ error: 'Arquivo excede o limite de 50 MB' });
      }
      chunks.push(chunk);
    }

    if (data.file.truncated) {
      return reply.code(413).send({ error: 'Arquivo excede o limite máximo permitido' });
    }

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      return reply.code(400).send({ error: 'Arquivo vazio' });
    }

    const mimeType = data.mimetype || 'application/octet-stream';
    const stored = await storage.storeBuffer({
      buffer,
      originalFilename: data.filename || 'upload',
      mimeType,
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
  });

  // Serve uploaded files securely
  app.get('/uploads/:storageKey', async (req, reply) => {
    const { storageKey } = req.params as { storageKey: string };
    const decoded = decodeURIComponent(storageKey);
    const localPath = storage.resolveLocalFilePath(decoded);
    if (!localPath) {
      return reply.code(404).send({ error: 'Arquivo não encontrado' });
    }

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
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.zip': 'application/zip',
    };
    const contentType = mimeByExt[ext] || 'application/octet-stream';
    const isSafeInline = contentType.startsWith('image/') || contentType === 'application/pdf';

    reply.header('Content-Type', contentType);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (!isSafeInline) {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(localPath)}"`);
    }
    return reply.send(fs.createReadStream(localPath));
  });

  // Official Desktop Installer Metadata & Download
  app.get('/api/releases/info', async () => {
    const externalUrl = process.env.DESKTOP_INSTALLER_URL || '';
    const installer = findDesktopInstallerFile();
    return {
      version: '1.0.0',
      platform: 'Windows 10 / 11 (64-bit)',
      available: Boolean(externalUrl || installer),
      filename: installer?.filename || 'Aether-Setup-1.0.0.exe',
      sizeBytes: installer?.sizeBytes || null,
      downloadUrl: externalUrl || '/api/releases/desktop/windows',
    };
  });

  app.get('/api/releases/desktop/windows', async (_req, reply) => {
    if (process.env.DESKTOP_INSTALLER_URL) {
      return reply.redirect(process.env.DESKTOP_INSTALLER_URL);
    }
    const installer = findDesktopInstallerFile();
    if (!installer) {
      return reply.code(404).send({
        error: 'Instalador Desktop ainda não foi compilado no diretório de releases.',
      });
    }
    reply.header('Content-Type', 'application/vnd.microsoft.portable-executable');
    reply.header('Content-Length', String(installer.sizeBytes));
    reply.header('Content-Disposition', `attachment; filename="${installer.filename}"`);
    return reply.send(fs.createReadStream(installer.fullPath));
  });
}

