import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import {
  DEFAULT_USER_SETTINGS,
  hasRoleAtLeast,
  USERNAME_MAX_CHANGES_PER_24H,
  UserRoleSchema,
  UserSettingsSchema,
  type AdminAuditLogEntry,
  type AdminUserRecord,
  type AuthUser,
  type ChatAttachment,
  type ChatMessage,
  type DirectMessage,
  type FriendEntry,
  type FriendshipStatus,
  type UpdateProfileInput,
  type UserPresenceStatus,
  type UserPublic,
  type UserRole,
  type UserSettings,
} from '@aether/shared';
import { config } from '../config.js';
import {
  computeBlindIndex,
  decryptSensitiveData,
  encryptSensitiveData,
  safeEqualHex,
} from '../security.js';

export interface DbUserRow {
  id: string;
  username: string;
  username_lower: string;
  display_name: string;
  email: string;
  email_lower: string;
  password_hash: string;
  avatar_color: string;
  avatar_url: string | null;
  bio?: string | null;
  presence_status?: string | null;
  role?: string | null;
  is_banned?: number | boolean | null;
  ban_reason?: string | null;
  settings_json: string;
  created_at: string;
}

export interface DbRoomRow {
  id: string;
  name: string;
  description: string;
  is_private: number | boolean;
  password_hash: string | null;
  owner_id: string | null;
  created_at: string;
}

export interface DbAttachmentRow {
  id: string;
  message_id: string | null;
  dm_message_id?: string | null;
  room_id: string | null;
  uploader_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  url_path: string;
  is_image: number | boolean;
  width: number | null;
  height: number | null;
  created_at: string;
}

interface SqlDriver {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  close(): Promise<void>;
}

/**
 * Converts positional `$1, $2...` PostgreSQL placeholders into `?` for node:sqlite.
 */
function toSqliteSql(pgSql: string): string {
  return pgSql.replace(/\$(\d+)/g, '?');
}

class SqliteWalDriver implements SqlDriver {
  private db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const converted = toSqliteSql(sql);
    const stmt = this.db.prepare(converted);
    const normalizedParams = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : (p ?? null)));
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(converted)) {
      return stmt.all(...(normalizedParams as never[])) as T[];
    }
    stmt.run(...(normalizedParams as never[]));
    return [];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDriver implements SqlDriver {
  private pool: pg.Pool;
  private readonly connectionString: string;
  private sslFallbackApplied = false;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = this.createPool(config.databaseSsl);
  }

  private createPool(useSsl: boolean): pg.Pool {
    const pool = new pg.Pool({
      connectionString: this.connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 12000,
      keepAlive: true,
      ssl: useSsl
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' }
        : undefined,
    });
    pool.on('error', (err) => {
      console.warn('[PostgresPool] Idle client warning (auto-recovering):', err.message);
    });
    return pool;
  }

  private async withRetry<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      const msg = err instanceof Error ? err.message : '';
      if (!this.sslFallbackApplied && /does not support SSL connections/i.test(msg)) {
        this.sslFallbackApplied = true;
        await this.pool.end().catch(() => {});
        this.pool = this.createPool(false);
        return fn();
      }
      const isTransient =
        code === '57P01' ||
        code === '57P03' ||
        code === '08006' ||
        code === '08003' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        /Connection terminated|terminating connection/i.test(msg);
      if (!isTransient) throw err;
      await new Promise((r) => setTimeout(r, 350));
      return fn();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.withRetry(() => this.pool.query(sql));
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.withRetry(() => this.pool.query(sql, params));
    return res.rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function makeConversationKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}

export class AppDatabase {
  private driver: SqlDriver;
  public readonly isPostgres: boolean;

  constructor(customSqlitePath?: string) {
    if (config.databaseUrl && /^postgres(ql)?:\/\//i.test(config.databaseUrl) && !customSqlitePath) {
      this.driver = new PostgresDriver(config.databaseUrl);
      this.isPostgres = true;
    } else {
      this.driver = new SqliteWalDriver(customSqlitePath || config.sqlitePath);
      this.isPostgres = false;
    }
  }

  async init(): Promise<void> {
    const boolType = this.isPostgres ? 'BOOLEAN' : 'INTEGER';
    const boolFalse = this.isPostgres ? 'FALSE' : '0';

    await this.driver.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        username_lower TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        email_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        avatar_url TEXT,
        bio TEXT NOT NULL DEFAULT '',
        presence_status TEXT NOT NULL DEFAULT 'online',
        role TEXT NOT NULL DEFAULT 'member',
        is_banned ${boolType} NOT NULL DEFAULT ${boolFalse},
        ban_reason TEXT,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS username_change_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        old_username TEXT NOT NULL,
        new_username TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_username_changes_user_time ON username_change_logs(user_id, changed_at DESC);

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT,
        family_id TEXT,
        expires_at TEXT NOT NULL,
        revoked ${boolType} NOT NULL DEFAULT ${boolFalse},
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_private ${boolType} NOT NULL DEFAULT ${boolFalse},
        password_hash TEXT,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_access (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted ${boolType} NOT NULL DEFAULT ${boolFalse}
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(requester_id, addressee_id)
      );

      CREATE INDEX IF NOT EXISTS idx_friendships_req ON friendships(requester_id, status);
      CREATE INDEX IF NOT EXISTS idx_friendships_addr ON friendships(addressee_id, status);

      CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        room_invite_json TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        read_at TEXT,
        deleted ${boolType} NOT NULL DEFAULT ${boolFalse}
      );

      CREATE INDEX IF NOT EXISTS idx_dm_conv_created ON direct_messages(conversation_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dm_recipient_unread ON direct_messages(recipient_id, read_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        dm_message_id TEXT,
        room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        storage_key TEXT NOT NULL,
        url_path TEXT NOT NULL,
        is_image ${boolType} NOT NULL DEFAULT ${boolFalse},
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        target_username TEXT,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
    `);

    // Safe idempotent schema upgrades for existing databases
    for (const alterSql of [
      'ALTER TABLE refresh_tokens ADD COLUMN token_hash TEXT',
      'ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT',
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
      `ALTER TABLE users ADD COLUMN is_banned ${boolType} NOT NULL DEFAULT ${boolFalse}`,
      'ALTER TABLE users ADD COLUMN ban_reason TEXT',
      "ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE users ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'online'",
      'ALTER TABLE attachments ADD COLUMN dm_message_id TEXT',
      'CREATE INDEX IF NOT EXISTS idx_attachments_dm_message ON attachments(dm_message_id)',
    ]) {
      try {
        await this.driver.exec(alterSql);
      } catch {
        // Column or index already exists
      }
    }

    // Transparently encrypt any legacy plaintext user emails in-place (AES-256-GCM + Blind Index)
    const legacyUsers = await this.driver.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE email NOT LIKE 'enc1$%'"
    );
    for (const u of legacyUsers) {
      const plainEmail = u.email.trim();
      const encEmail = encryptSensitiveData(plainEmail);
      const blindIdx = computeBlindIndex(plainEmail);
      await this.driver.query('UPDATE users SET email = $1, email_lower = $2 WHERE id = $3', [
        encEmail,
        blindIdx,
        u.id,
      ]);
    }

    // Seed initial empty real public channels only if zero rooms exist in DB
    const countRow = await this.driver.queryOne<{ cnt: number | string }>(
      'SELECT COUNT(*) as cnt FROM rooms'
    );
    const totalRooms = Number(countRow?.cnt ?? 0);
    if (totalRooms === 0) {
      const now = new Date().toISOString();
      await this.driver.query(
        `INSERT INTO rooms (id, name, description, is_private, password_hash, owner_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['room-geral', 'Geral', 'Canal principal de voz, chat e transmissões', false, null, null, now]
      );
      await this.driver.query(
        `INSERT INTO rooms (id, name, description, is_private, password_hash, owner_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'room-cinema-jogos',
          'Jogos & Cinema 2K',
          'Sala otimizada para lives em 1080p, 1440p e Original até 144 FPS com áudio estéreo',
          false,
          null,
          null,
          now,
        ]
      );
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  public parseUserRole(raw?: string | null): UserRole {
    const parsed = UserRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : 'member';
  }

  public parsePresenceStatus(raw?: string | null): UserPresenceStatus {
    if (raw === 'busy') return 'busy';
    if (raw === 'offline') return 'offline';
    return 'online';
  }

  public mapUserPublic(row: DbUserRow): UserPublic {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url,
      bio: row.bio ?? '',
      presenceStatus: this.parsePresenceStatus(row.presence_status),
      role: this.parseUserRole(row.role),
      createdAt: row.created_at,
    };
  }

  public async getNicknameRateLimitState(userId: string): Promise<{
    changesLast24h: number;
    lockedUntil: string | null;
  }> {
    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.driver.query<{ changed_at: string }>(
      `SELECT changed_at FROM username_change_logs
       WHERE user_id = $1 AND changed_at > $2
       ORDER BY changed_at ASC`,
      [userId, cutoffIso]
    );
    const changesLast24h = rows.length;
    if (changesLast24h >= USERNAME_MAX_CHANGES_PER_24H && rows[0]) {
      const unlockMs = new Date(rows[0].changed_at).getTime() + 24 * 60 * 60 * 1000;
      return {
        changesLast24h,
        lockedUntil: new Date(unlockMs).toISOString(),
      };
    }
    return { changesLast24h, lockedUntil: null };
  }

  public mapAuthUser(
    row: DbUserRow,
    nicknameMeta?: { changesLast24h: number; lockedUntil: string | null }
  ): AuthUser {
    let parsedSettings: UserSettings = DEFAULT_USER_SETTINGS;
    try {
      parsedSettings = UserSettingsSchema.parse(JSON.parse(row.settings_json));
    } catch {
      parsedSettings = DEFAULT_USER_SETTINGS;
    }
    let decryptedEmail = row.email;
    try {
      decryptedEmail = decryptSensitiveData(row.email);
    } catch {
      decryptedEmail = row.email;
    }
    return {
      ...this.mapUserPublic(row),
      email: decryptedEmail,
      settings: parsedSettings,
      nicknameChangesLast24h: nicknameMeta?.changesLast24h ?? 0,
      nicknameLockedUntil: nicknameMeta?.lockedUntil ?? null,
    };
  }

  public async enrichAuthUser(row: DbUserRow): Promise<AuthUser> {
    const nicknameMeta = await this.getNicknameRateLimitState(row.id);
    return this.mapAuthUser(row, nicknameMeta);
  }

  async createUser(params: {
    username: string;
    displayName: string;
    email: string;
    passwordHash: string;
    avatarColor: string;
  }): Promise<AuthUser> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const settingsJson = JSON.stringify(DEFAULT_USER_SETTINGS);
    const cleanEmail = params.email.trim();
    const encryptedEmail = encryptSensitiveData(cleanEmail);
    const emailBlindIndex = computeBlindIndex(cleanEmail);

    await this.driver.query(
      `INSERT INTO users (
        id, username, username_lower, display_name, email, email_lower,
        password_hash, avatar_color, avatar_url, bio, presence_status, settings_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        params.username,
        params.username.toLowerCase(),
        params.displayName,
        encryptedEmail,
        emailBlindIndex,
        params.passwordHash,
        params.avatarColor,
        null,
        '',
        'online',
        settingsJson,
        now,
      ]
    );

    const created = await this.findUserRowById(id);
    if (!created) throw new Error('Falha ao persistir usuário');
    return this.enrichAuthUser(created);
  }

  async updateUserPasswordHash(userId: string, newPasswordHash: string): Promise<void> {
    await this.driver.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      newPasswordHash,
      userId,
    ]);
  }

  async findUserRowById(id: string): Promise<DbUserRow | null> {
    return this.driver.queryOne<DbUserRow>('SELECT * FROM users WHERE id = $1', [id]);
  }

  async findUserRowByIdentifier(identifier: string): Promise<DbUserRow | null> {
    const lower = identifier.trim().toLowerCase();
    const emailBlindIdx = computeBlindIndex(lower);
    return this.driver.queryOne<DbUserRow>(
      'SELECT * FROM users WHERE email_lower = $1 OR username_lower = $2',
      [emailBlindIdx, lower]
    );
  }

  async checkUserConflict(username: string, email: string): Promise<'username' | 'email' | null> {
    const byUsername = await this.driver.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE username_lower = $1',
      [username.toLowerCase()]
    );
    if (byUsername) return 'username';
    const emailBlindIdx = computeBlindIndex(email.trim().toLowerCase());
    const byEmail = await this.driver.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email_lower = $1',
      [emailBlindIdx]
    );
    if (byEmail) return 'email';
    return null;
  }

  async findUsersByUsernames(usernamesLower: string[]): Promise<UserPublic[]> {
    if (usernamesLower.length === 0) return [];
    const results: UserPublic[] = [];
    for (const uname of usernamesLower) {
      const row = await this.driver.queryOne<DbUserRow>(
        'SELECT * FROM users WHERE username_lower = $1',
        [uname.toLowerCase()]
      );
      if (row) results.push(this.mapUserPublic(row));
    }
    return results;
  }

  async updateUserSettings(userId: string, settings: UserSettings): Promise<UserSettings> {
    const validated = UserSettingsSchema.parse(settings);
    await this.driver.query('UPDATE users SET settings_json = $1 WHERE id = $2', [
      JSON.stringify(validated),
      userId,
    ]);
    return validated;
  }

  async updateUserProfile(
    userId: string,
    updates: UpdateProfileInput
  ): Promise<AuthUser | null> {
    const current = await this.findUserRowById(userId);
    if (!current) return null;

    let nextUsername = current.username;
    let nextUsernameLower = current.username_lower;
    let didChangeUsername = false;

    if (updates.username !== undefined && updates.username.trim() !== current.username) {
      const requestedUsername = updates.username.trim();
      const requestedLower = requestedUsername.toLowerCase();

      const rateState = await this.getNicknameRateLimitState(userId);
      if (rateState.changesLast24h >= USERNAME_MAX_CHANGES_PER_24H && rateState.lockedUntil) {
        throw Object.assign(
          new Error(
            `Você já alterou seu nickname ${USERNAME_MAX_CHANGES_PER_24H} vezes nas últimas 24 horas. Aguarde o desbloqueio automático.`
          ),
          {
            code: 'NICKNAME_RATE_LIMIT',
            lockedUntil: rateState.lockedUntil,
          }
        );
      }

      if (requestedLower !== current.username_lower) {
        const conflict = await this.driver.queryOne<{ id: string }>(
          'SELECT id FROM users WHERE username_lower = $1 AND id != $2',
          [requestedLower, userId]
        );
        if (conflict) {
          throw Object.assign(new Error('Este nickname já está sendo usado por outra pessoa'), {
            code: 'USERNAME_TAKEN',
          });
        }
      }

      nextUsername = requestedUsername;
      nextUsernameLower = requestedLower;
      didChangeUsername = true;
    }

    const nextDisplayName =
      updates.displayName !== undefined ? updates.displayName.trim() : current.display_name;
    const nextBio = updates.bio !== undefined ? updates.bio.trim() : (current.bio ?? '');
    const nextAvatarColor =
      updates.avatarColor !== undefined ? updates.avatarColor : current.avatar_color;
    const nextAvatarUrl =
      updates.avatarUrl !== undefined ? updates.avatarUrl : current.avatar_url;
    const nextPresence =
      updates.presenceStatus !== undefined
        ? updates.presenceStatus
        : this.parsePresenceStatus(current.presence_status);

    await this.driver.query(
      `UPDATE users
       SET username = $1,
           username_lower = $2,
           display_name = $3,
           bio = $4,
           avatar_color = $5,
           avatar_url = $6,
           presence_status = $7
       WHERE id = $8`,
      [
        nextUsername,
        nextUsernameLower,
        nextDisplayName,
        nextBio,
        nextAvatarColor,
        nextAvatarUrl,
        nextPresence,
        userId,
      ]
    );

    if (didChangeUsername) {
      await this.driver.query(
        `INSERT INTO username_change_logs (id, user_id, old_username, new_username, changed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          crypto.randomUUID(),
          userId,
          current.username,
          nextUsername,
          new Date().toISOString(),
        ]
      );
    }

    const updated = await this.findUserRowById(userId);
    return updated ? this.enrichAuthUser(updated) : null;
  }

  async storeRefreshToken(params: {
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAtIso: string;
  }): Promise<void> {
    await this.driver.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, revoked, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        params.id,
        params.userId,
        params.tokenHash,
        params.familyId,
        params.expiresAtIso,
        false,
        new Date().toISOString(),
      ]
    );
  }

  async consumeRefreshToken(
    id: string,
    userId: string,
    presentedTokenHash: string
  ): Promise<{ ok: boolean; familyId?: string; replayDetected?: boolean }> {
    const row = await this.driver.queryOne<{
      id: string;
      token_hash: string | null;
      family_id: string | null;
      expires_at: string;
      revoked: number | boolean;
    }>(
      'SELECT id, token_hash, family_id, expires_at, revoked FROM refresh_tokens WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (!row) return { ok: false };

    if (Boolean(row.revoked)) {
      await this.revokeAllUserRefreshTokens(userId);
      return { ok: false, replayDetected: true };
    }

    if (row.token_hash && !safeEqualHex(row.token_hash, presentedTokenHash)) {
      return { ok: false };
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.driver.query('UPDATE refresh_tokens SET revoked = $1 WHERE id = $2', [true, id]);
      return { ok: false };
    }

    await this.driver.query('UPDATE refresh_tokens SET revoked = $1 WHERE id = $2', [true, id]);
    return { ok: true, familyId: row.family_id || id };
  }

  async revokeRefreshToken(id: string): Promise<void> {
    await this.driver.query('UPDATE refresh_tokens SET revoked = $1 WHERE id = $2', [true, id]);
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.driver.query('UPDATE refresh_tokens SET revoked = $1 WHERE user_id = $2', [
      true,
      userId,
    ]);
  }

  // Rooms
  async listAllRooms(): Promise<DbRoomRow[]> {
    return this.driver.query<DbRoomRow>('SELECT * FROM rooms ORDER BY created_at ASC');
  }

  async getRoomById(roomId: string): Promise<DbRoomRow | null> {
    return this.driver.queryOne<DbRoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
  }

  async createRoom(params: {
    name: string;
    description: string;
    isPrivate: boolean;
    passwordHash: string | null;
    ownerId: string;
  }): Promise<DbRoomRow> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.query(
      `INSERT INTO rooms (id, name, description, is_private, password_hash, owner_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        params.name,
        params.description,
        params.isPrivate,
        params.passwordHash,
        params.ownerId,
        now,
      ]
    );
    await this.grantRoomAccess(id, params.ownerId);
    const row = await this.getRoomById(id);
    if (!row) throw new Error('Falha ao criar sala');
    return row;
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.driver.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  }

  async grantRoomAccess(roomId: string, userId: string): Promise<void> {
    const existing = await this.driver.queryOne<{ room_id: string }>(
      'SELECT room_id FROM room_access WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    if (!existing) {
      await this.driver.query(
        'INSERT INTO room_access (room_id, user_id, granted_at) VALUES ($1, $2, $3)',
        [roomId, userId, new Date().toISOString()]
      );
    }
  }

  async hasRoomAccess(roomId: string, userId: string): Promise<boolean> {
    const existing = await this.driver.queryOne<{ room_id: string }>(
      'SELECT room_id FROM room_access WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    return Boolean(existing);
  }

  // Attachments
  public mapAttachment(row: DbAttachmentRow): ChatAttachment {
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      url: row.url_path,
      isImage: Boolean(row.is_image),
      width: row.width !== null ? Number(row.width) : null,
      height: row.height !== null ? Number(row.height) : null,
    };
  }

  async createAttachment(params: {
    uploaderId: string;
    roomId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    urlPath: string;
    isImage: boolean;
    width?: number | null;
    height?: number | null;
  }): Promise<ChatAttachment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.query(
      `INSERT INTO attachments (
        id, message_id, dm_message_id, room_id, uploader_id, filename, mime_type,
        size_bytes, storage_key, url_path, is_image, width, height, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        null,
        null,
        params.roomId,
        params.uploaderId,
        params.filename,
        params.mimeType,
        params.sizeBytes,
        params.storageKey,
        params.urlPath,
        params.isImage,
        params.width ?? null,
        params.height ?? null,
        now,
      ]
    );
    const created = await this.driver.queryOne<DbAttachmentRow>(
      'SELECT * FROM attachments WHERE id = $1',
      [id]
    );
    if (!created) throw new Error('Falha ao registrar arquivo');
    return this.mapAttachment(created);
  }

  async getAttachmentRowById(id: string): Promise<DbAttachmentRow | null> {
    return this.driver.queryOne<DbAttachmentRow>('SELECT * FROM attachments WHERE id = $1', [id]);
  }

  // Room Messages
  async createMessage(params: {
    roomId: string;
    authorId: string;
    content: string;
    mentionUserIds: string[];
    attachmentIds: string[];
  }): Promise<ChatMessage> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.query(
      `INSERT INTO messages (id, room_id, author_id, content, mentions_json, created_at, edited_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        params.roomId,
        params.authorId,
        params.content,
        JSON.stringify(params.mentionUserIds),
        now,
        null,
        false,
      ]
    );

    for (const attId of params.attachmentIds) {
      await this.driver.query(
        'UPDATE attachments SET message_id = $1, room_id = $2 WHERE id = $3 AND uploader_id = $4 AND message_id IS NULL AND dm_message_id IS NULL',
        [id, params.roomId, attId, params.authorId]
      );
    }

    const msg = await this.getMessageById(id);
    if (!msg) throw new Error('Falha ao carregar mensagem criada');
    return msg;
  }

  async getMessageById(messageId: string): Promise<ChatMessage | null> {
    const row = await this.driver.queryOne<{
      id: string;
      room_id: string;
      author_id: string;
      content: string;
      mentions_json: string;
      created_at: string;
      edited_at: string | null;
      deleted: number | boolean;
      u_id: string;
      u_username: string;
      u_display_name: string;
      u_avatar_color: string;
      u_avatar_url: string | null;
      u_bio: string | null;
      u_presence_status: string | null;
      u_role: string | null;
      u_created_at: string;
    }>(
      `SELECT
        m.id, m.room_id, m.author_id, m.content, m.mentions_json, m.created_at, m.edited_at, m.deleted,
        u.id as u_id, u.username as u_username, u.display_name as u_display_name,
        u.avatar_color as u_avatar_color, u.avatar_url as u_avatar_url,
        u.bio as u_bio, u.presence_status as u_presence_status,
        u.role as u_role, u.created_at as u_created_at
       FROM messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.id = $1`,
      [messageId]
    );
    if (!row) return null;

    const attRows = await this.driver.query<DbAttachmentRow>(
      'SELECT * FROM attachments WHERE message_id = $1 ORDER BY created_at ASC',
      [messageId]
    );

    let mentions: string[] = [];
    try {
      mentions = JSON.parse(row.mentions_json);
    } catch {
      mentions = [];
    }

    const isDeleted = Boolean(row.deleted);
    return {
      id: row.id,
      roomId: row.room_id,
      author: {
        id: row.u_id,
        username: row.u_username,
        displayName: row.u_display_name,
        avatarColor: row.u_avatar_color,
        avatarUrl: row.u_avatar_url,
        bio: row.u_bio ?? '',
        presenceStatus: this.parsePresenceStatus(row.u_presence_status),
        role: this.parseUserRole(row.u_role),
        createdAt: row.u_created_at,
      },
      content: isDeleted ? '' : row.content,
      mentions: isDeleted ? [] : mentions,
      attachments: isDeleted ? [] : attRows.map((a) => this.mapAttachment(a)),
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deleted: isDeleted,
    };
  }

  async listRoomMessages(roomId: string, limit = 50, beforeCreatedAt?: string): Promise<ChatMessage[]> {
    const notDeletedVal = this.isPostgres ? false : 0;
    const rows = beforeCreatedAt
      ? await this.driver.query<{ id: string }>(
          `SELECT id FROM messages
           WHERE room_id = $1 AND deleted = $2 AND created_at < $3
           ORDER BY created_at DESC
           LIMIT $4`,
          [roomId, notDeletedVal, beforeCreatedAt, limit]
        )
      : await this.driver.query<{ id: string }>(
          `SELECT id FROM messages
           WHERE room_id = $1 AND deleted = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [roomId, notDeletedVal, limit]
        );

    const messages: ChatMessage[] = [];
    for (const r of rows.reverse()) {
      const full = await this.getMessageById(r.id);
      if (full && !full.deleted) messages.push(full);
    }
    return messages;
  }

  async editMessage(
    messageId: string,
    authorId: string,
    newContent: string,
    mentionUserIds: string[]
  ): Promise<ChatMessage | null> {
    const existing = await this.getMessageById(messageId);
    if (!existing || existing.deleted || existing.author.id !== authorId) return null;

    const now = new Date().toISOString();
    await this.driver.query(
      'UPDATE messages SET content = $1, mentions_json = $2, edited_at = $3 WHERE id = $4',
      [newContent, JSON.stringify(mentionUserIds), now, messageId]
    );
    return this.getMessageById(messageId);
  }

  async softDeleteMessage(
    messageId: string,
    requesterId: string,
    roomOwnerId: string | null,
    requesterRole?: UserRole
  ): Promise<{ roomId: string; deleted: boolean } | null> {
    const existing = await this.getMessageById(messageId);
    if (!existing || existing.deleted) return null;
    const isStaffModerator = hasRoleAtLeast(requesterRole, 'moderator');
    if (existing.author.id !== requesterId && roomOwnerId !== requesterId && !isStaffModerator) {
      return null;
    }
    await this.driver.query('UPDATE messages SET deleted = $1, content = $2 WHERE id = $3', [
      true,
      '',
      messageId,
    ]);
    return { roomId: existing.roomId, deleted: true };
  }

  // Friends System
  async sendFriendRequest(
    requesterId: string,
    targetUsernameRaw: string
  ): Promise<{ friendshipId: string; targetUser: UserPublic; autoAccepted: boolean }> {
    const cleanTarget = targetUsernameRaw.trim().replace(/^@+/, '').toLowerCase();
    const targetRow = await this.driver.queryOne<DbUserRow>(
      'SELECT * FROM users WHERE username_lower = $1',
      [cleanTarget]
    );
    if (!targetRow) {
      throw Object.assign(new Error('Nenhum usuário encontrado com este nickname'), {
        code: 'USER_NOT_FOUND',
      });
    }
    if (targetRow.id === requesterId) {
      throw Object.assign(new Error('Você não pode adicionar a si mesmo como amigo'), {
        code: 'CANNOT_ADD_SELF',
      });
    }

    const existing = await this.driver.queryOne<{
      id: string;
      requester_id: string;
      addressee_id: string;
      status: string;
    }>(
      `SELECT id, requester_id, addressee_id, status
       FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $3 AND addressee_id = $4)`,
      [requesterId, targetRow.id, targetRow.id, requesterId]
    );

    const now = new Date().toISOString();
    const targetUser = this.mapUserPublic(targetRow);

    if (existing) {
      if (existing.status === 'accepted') {
        throw Object.assign(new Error('Vocês já são amigos!'), { code: 'ALREADY_FRIENDS' });
      }
      if (existing.requester_id === requesterId) {
        throw Object.assign(new Error('Solicitação de amizade já enviada e pendente'), {
          code: 'REQUEST_ALREADY_SENT',
        });
      }
      // Target user had already sent us a request -> automatically accept mutual friendship!
      await this.driver.query(
        'UPDATE friendships SET status = $1, updated_at = $2 WHERE id = $3',
        ['accepted', now, existing.id]
      );
      return { friendshipId: existing.id, targetUser, autoAccepted: true };
    }

    const friendshipId = crypto.randomUUID();
    await this.driver.query(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [friendshipId, requesterId, targetRow.id, 'pending', now, now]
    );

    return { friendshipId, targetUser, autoAccepted: false };
  }

  async respondFriendRequest(
    friendshipId: string,
    userId: string,
    accept: boolean
  ): Promise<{ requesterId: string; addresseeId: string; accepted: boolean }> {
    const existing = await this.driver.queryOne<{
      id: string;
      requester_id: string;
      addressee_id: string;
      status: string;
    }>('SELECT id, requester_id, addressee_id, status FROM friendships WHERE id = $1', [
      friendshipId,
    ]);

    if (!existing) {
      throw Object.assign(new Error('Solicitação de amizade não encontrada'), {
        code: 'NOT_FOUND',
      });
    }

    if (accept) {
      if (existing.addressee_id !== userId) {
        throw Object.assign(new Error('Somente o destinatário pode aceitar esta solicitação'), {
          code: 'FORBIDDEN',
        });
      }
      await this.driver.query(
        'UPDATE friendships SET status = $1, updated_at = $2 WHERE id = $3',
        ['accepted', new Date().toISOString(), friendshipId]
      );
      return {
        requesterId: existing.requester_id,
        addresseeId: existing.addressee_id,
        accepted: true,
      };
    }

    if (existing.addressee_id !== userId && existing.requester_id !== userId) {
      throw Object.assign(new Error('Sem permissão para recusar esta solicitação'), {
        code: 'FORBIDDEN',
      });
    }

    await this.driver.query('DELETE FROM friendships WHERE id = $1', [friendshipId]);
    return {
      requesterId: existing.requester_id,
      addresseeId: existing.addressee_id,
      accepted: false,
    };
  }

  async removeFriendship(
    friendshipId: string,
    userId: string
  ): Promise<{ otherUserId: string }> {
    const existing = await this.driver.queryOne<{
      id: string;
      requester_id: string;
      addressee_id: string;
    }>('SELECT id, requester_id, addressee_id FROM friendships WHERE id = $1', [friendshipId]);

    if (!existing || (existing.requester_id !== userId && existing.addressee_id !== userId)) {
      throw Object.assign(new Error('Amizade não encontrada'), { code: 'NOT_FOUND' });
    }

    await this.driver.query('DELETE FROM friendships WHERE id = $1', [friendshipId]);
    const otherUserId =
      existing.requester_id === userId ? existing.addressee_id : existing.requester_id;
    return { otherUserId };
  }

  async areUsersFriends(userA: string, userB: string): Promise<boolean> {
    if (userA === userB) return true;
    const row = await this.driver.queryOne<{ id: string }>(
      `SELECT id FROM friendships
       WHERE status = $1
         AND ((requester_id = $2 AND addressee_id = $3)
           OR (requester_id = $4 AND addressee_id = $5))`,
      ['accepted', userA, userB, userB, userA]
    );
    return Boolean(row);
  }

  async listAcceptedFriendUserIds(userId: string): Promise<string[]> {
    const rows = await this.driver.query<{ requester_id: string; addressee_id: string }>(
      `SELECT requester_id, addressee_id FROM friendships
       WHERE status = $1 AND (requester_id = $2 OR addressee_id = $3)`,
      ['accepted', userId, userId]
    );
    return rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
  }

  async listFriendsForUser(
    userId: string,
    resolveLiveState: (friendUser: UserPublic) => {
      isOnline: boolean;
      currentRoomId: string | null;
      currentRoomName: string | null;
      isStreaming: boolean;
    }
  ): Promise<FriendEntry[]> {
    const rows = await this.driver.query<{
      f_id: string;
      f_requester_id: string;
      f_addressee_id: string;
      f_status: string;
      f_created_at: string;
      u_id: string;
      u_username: string;
      u_display_name: string;
      u_avatar_color: string;
      u_avatar_url: string | null;
      u_bio: string | null;
      u_presence_status: string | null;
      u_role: string | null;
      u_created_at: string;
    }>(
      `SELECT
        f.id as f_id, f.requester_id as f_requester_id, f.addressee_id as f_addressee_id,
        f.status as f_status, f.created_at as f_created_at,
        u.id as u_id, u.username as u_username, u.display_name as u_display_name,
        u.avatar_color as u_avatar_color, u.avatar_url as u_avatar_url,
        u.bio as u_bio, u.presence_status as u_presence_status,
        u.role as u_role, u.created_at as u_created_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.requester_id = $2 OR f.addressee_id = $3
       ORDER BY f.updated_at DESC`,
      [userId, userId, userId]
    );

    const notDeletedVal = this.isPostgres ? false : 0;
    const unreadRows = await this.driver.query<{ sender_id: string; cnt: number | string }>(
      `SELECT sender_id, COUNT(*) as cnt
       FROM direct_messages
       WHERE recipient_id = $1 AND read_at IS NULL AND deleted = $2
       GROUP BY sender_id`,
      [userId, notDeletedVal]
    );
    const unreadBySender = new Map<string, number>();
    for (const ur of unreadRows) {
      unreadBySender.set(ur.sender_id, Number(ur.cnt));
    }

    const entries: FriendEntry[] = [];
    for (const r of rows) {
      const friendUser: UserPublic = {
        id: r.u_id,
        username: r.u_username,
        displayName: r.u_display_name,
        avatarColor: r.u_avatar_color,
        avatarUrl: r.u_avatar_url,
        bio: r.u_bio ?? '',
        presenceStatus: this.parsePresenceStatus(r.u_presence_status),
        role: this.parseUserRole(r.u_role),
        createdAt: r.u_created_at,
      };

      let status: FriendshipStatus = 'accepted';
      if (r.f_status !== 'accepted') {
        status = r.f_requester_id === userId ? 'pending_outgoing' : 'pending_incoming';
      }

      const convKey = makeConversationKey(userId, friendUser.id);
      const lastDmRow = await this.driver.queryOne<{ created_at: string }>(
        `SELECT created_at FROM direct_messages
         WHERE conversation_key = $1 AND deleted = $2
         ORDER BY created_at DESC LIMIT 1`,
        [convKey, notDeletedVal]
      );

      const live = resolveLiveState(friendUser);
      const effectivePresence: UserPresenceStatus = live.isOnline
        ? friendUser.presenceStatus === 'busy'
          ? 'busy'
          : 'online'
        : 'offline';

      entries.push({
        friendshipId: r.f_id,
        user: friendUser,
        status,
        isOnline: live.isOnline,
        presenceStatus: effectivePresence,
        currentRoomId: live.currentRoomId,
        currentRoomName: live.currentRoomName,
        isStreaming: live.isStreaming,
        unreadDmCount: unreadBySender.get(friendUser.id) ?? 0,
        lastDmAt: lastDmRow?.created_at ?? null,
        createdAt: r.f_created_at,
      });
    }

    return entries;
  }

  // Direct Messages (DMs)
  async createDirectMessage(params: {
    senderId: string;
    recipientId: string;
    content: string;
    mentionUserIds: string[];
    attachmentIds: string[];
    roomInvite?: { roomId: string; roomName: string } | null;
  }): Promise<DirectMessage> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const conversationKey = makeConversationKey(params.senderId, params.recipientId);

    await this.driver.query(
      `INSERT INTO direct_messages (
        id, conversation_key, sender_id, recipient_id, content,
        mentions_json, room_invite_json, created_at, edited_at, read_at, deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        conversationKey,
        params.senderId,
        params.recipientId,
        params.content,
        JSON.stringify(params.mentionUserIds),
        params.roomInvite ? JSON.stringify(params.roomInvite) : null,
        now,
        null,
        null,
        false,
      ]
    );

    for (const attId of params.attachmentIds) {
      await this.driver.query(
        'UPDATE attachments SET dm_message_id = $1 WHERE id = $2 AND uploader_id = $3 AND message_id IS NULL AND dm_message_id IS NULL',
        [id, attId, params.senderId]
      );
    }

    const created = await this.getDirectMessageById(id);
    if (!created) throw new Error('Falha ao criar mensagem direta');
    return created;
  }

  async getDirectMessageById(messageId: string): Promise<DirectMessage | null> {
    const row = await this.driver.queryOne<{
      id: string;
      conversation_key: string;
      sender_id: string;
      recipient_id: string;
      content: string;
      mentions_json: string;
      room_invite_json: string | null;
      created_at: string;
      edited_at: string | null;
      read_at: string | null;
      deleted: number | boolean;
      u_id: string;
      u_username: string;
      u_display_name: string;
      u_avatar_color: string;
      u_avatar_url: string | null;
      u_bio: string | null;
      u_presence_status: string | null;
      u_role: string | null;
      u_created_at: string;
    }>(
      `SELECT
        d.id, d.conversation_key, d.sender_id, d.recipient_id, d.content,
        d.mentions_json, d.room_invite_json, d.created_at, d.edited_at, d.read_at, d.deleted,
        u.id as u_id, u.username as u_username, u.display_name as u_display_name,
        u.avatar_color as u_avatar_color, u.avatar_url as u_avatar_url,
        u.bio as u_bio, u.presence_status as u_presence_status,
        u.role as u_role, u.created_at as u_created_at
       FROM direct_messages d
       JOIN users u ON u.id = d.sender_id
       WHERE d.id = $1`,
      [messageId]
    );
    if (!row) return null;

    const attRows = await this.driver.query<DbAttachmentRow>(
      'SELECT * FROM attachments WHERE dm_message_id = $1 ORDER BY created_at ASC',
      [messageId]
    );

    let mentions: string[] = [];
    try {
      mentions = JSON.parse(row.mentions_json);
    } catch {
      mentions = [];
    }

    let roomInvite: { roomId: string; roomName: string } | null = null;
    if (row.room_invite_json) {
      try {
        const parsed = JSON.parse(row.room_invite_json);
        if (parsed?.roomId && parsed?.roomName) {
          roomInvite = { roomId: String(parsed.roomId), roomName: String(parsed.roomName) };
        }
      } catch {
        roomInvite = null;
      }
    }

    const isDeleted = Boolean(row.deleted);
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      sender: {
        id: row.u_id,
        username: row.u_username,
        displayName: row.u_display_name,
        avatarColor: row.u_avatar_color,
        avatarUrl: row.u_avatar_url,
        bio: row.u_bio ?? '',
        presenceStatus: this.parsePresenceStatus(row.u_presence_status),
        role: this.parseUserRole(row.u_role),
        createdAt: row.u_created_at,
      },
      recipientId: row.recipient_id,
      content: isDeleted ? '' : row.content,
      mentions: isDeleted ? [] : mentions,
      attachments: isDeleted ? [] : attRows.map((a) => this.mapAttachment(a)),
      roomInvite: isDeleted ? null : roomInvite,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      readAt: row.read_at,
      deleted: isDeleted,
    };
  }

  async listDirectMessages(
    userId: string,
    peerUserId: string,
    limit = 60,
    beforeCreatedAt?: string
  ): Promise<DirectMessage[]> {
    const convKey = makeConversationKey(userId, peerUserId);
    const notDeletedVal = this.isPostgres ? false : 0;

    const rows = beforeCreatedAt
      ? await this.driver.query<{ id: string }>(
          `SELECT id FROM direct_messages
           WHERE conversation_key = $1 AND deleted = $2 AND created_at < $3
           ORDER BY created_at DESC
           LIMIT $4`,
          [convKey, notDeletedVal, beforeCreatedAt, limit]
        )
      : await this.driver.query<{ id: string }>(
          `SELECT id FROM direct_messages
           WHERE conversation_key = $1 AND deleted = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [convKey, notDeletedVal, limit]
        );

    const list: DirectMessage[] = [];
    for (const r of rows.reverse()) {
      const dm = await this.getDirectMessageById(r.id);
      if (dm && !dm.deleted) list.push(dm);
    }
    return list;
  }

  async editDirectMessage(
    messageId: string,
    senderId: string,
    newContent: string,
    mentionUserIds: string[]
  ): Promise<DirectMessage | null> {
    const existing = await this.getDirectMessageById(messageId);
    if (!existing || existing.deleted || existing.sender.id !== senderId) return null;

    await this.driver.query(
      'UPDATE direct_messages SET content = $1, mentions_json = $2, edited_at = $3 WHERE id = $4',
      [newContent, JSON.stringify(mentionUserIds), new Date().toISOString(), messageId]
    );
    return this.getDirectMessageById(messageId);
  }

  async softDeleteDirectMessage(
    messageId: string,
    requesterId: string
  ): Promise<{ conversationKey: string; senderId: string; recipientId: string } | null> {
    const existing = await this.getDirectMessageById(messageId);
    if (!existing || existing.deleted || existing.sender.id !== requesterId) return null;

    await this.driver.query(
      'UPDATE direct_messages SET deleted = $1, content = $2 WHERE id = $3',
      [true, '', messageId]
    );
    return {
      conversationKey: existing.conversationKey,
      senderId: existing.sender.id,
      recipientId: existing.recipientId,
    };
  }

  async markDirectMessagesRead(
    readerUserId: string,
    peerUserId: string
  ): Promise<{ readAt: string }> {
    const readAt = new Date().toISOString();
    const notDeletedVal = this.isPostgres ? false : 0;
    await this.driver.query(
      `UPDATE direct_messages
       SET read_at = $1
       WHERE recipient_id = $2 AND sender_id = $3 AND read_at IS NULL AND deleted = $4`,
      [readAt, readerUserId, peerUserId, notDeletedVal]
    );
    return { readAt };
  }

  // Administration & RBAC
  async setUserRole(userId: string, role: UserRole): Promise<AuthUser | null> {
    const validatedRole = UserRoleSchema.parse(role);
    await this.driver.query('UPDATE users SET role = $1 WHERE id = $2', [validatedRole, userId]);
    const updated = await this.findUserRowById(userId);
    return updated ? this.enrichAuthUser(updated) : null;
  }

  async setUserBanState(
    userId: string,
    isBanned: boolean,
    reason: string | null
  ): Promise<DbUserRow | null> {
    await this.driver.query('UPDATE users SET is_banned = $1, ban_reason = $2 WHERE id = $3', [
      isBanned,
      isBanned ? reason : null,
      userId,
    ]);
    return this.findUserRowById(userId);
  }

  async listAllUsersForAdmin(onlineUserMap: Map<string, string | null>): Promise<AdminUserRecord[]> {
    const rows = await this.driver.query<DbUserRow>(
      'SELECT * FROM users ORDER BY created_at ASC'
    );
    return rows.map((row) => {
      const isOnline = onlineUserMap.has(row.id);
      const currentRoomId = onlineUserMap.get(row.id) ?? null;
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarColor: row.avatar_color,
        avatarUrl: row.avatar_url,
        bio: row.bio ?? '',
        role: this.parseUserRole(row.role),
        isBanned: Boolean(row.is_banned),
        banReason: row.ban_reason ?? null,
        isOnline,
        currentRoomId,
        createdAt: row.created_at,
      };
    });
  }

  async recordAdminAuditLog(params: {
    actorId: string;
    actorRole: UserRole;
    action: string;
    targetUserId?: string | null;
    targetUsername?: string | null;
    details: string;
  }): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.driver.query(
      `INSERT INTO admin_audit_logs (
        id, actor_id, actor_role, action, target_user_id, target_username, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        params.actorId,
        params.actorRole,
        params.action,
        params.targetUserId ?? null,
        params.targetUsername ?? null,
        params.details,
        now,
      ]
    );
  }

  async listAdminAuditLogs(limit = 80): Promise<AdminAuditLogEntry[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = await this.driver.query<{
      id: string;
      actor_id: string;
      actor_role: string;
      action: string;
      target_user_id: string | null;
      target_username: string | null;
      details: string;
      created_at: string;
      u_username: string;
      u_display_name: string;
    }>(
      `SELECT
        l.id, l.actor_id, l.actor_role, l.action, l.target_user_id, l.target_username, l.details, l.created_at,
        u.username as u_username, u.display_name as u_display_name
       FROM admin_audit_logs l
       JOIN users u ON u.id = l.actor_id
       ORDER BY l.created_at DESC
       LIMIT $1`,
      [safeLimit]
    );

    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorUsername: r.u_username,
      actorDisplayName: r.u_display_name,
      actorRole: this.parseUserRole(r.actor_role),
      action: r.action,
      targetUserId: r.target_user_id,
      targetUsername: r.target_username,
      details: r.details,
      createdAt: r.created_at,
    }));
  }
}
