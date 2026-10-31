import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { ClusterBus } from './cluster/ClusterBus.js';
import { config } from './config.js';
import { AppDatabase } from './db/Database.js';
import { registerApiRoutes } from './routes/api.js';
import { SfuManager } from './sfu/SfuManager.js';
import { StorageService } from './storage/StorageService.js';
import { RealtimeGateway } from './ws/RealtimeGateway.js';

export interface ServerContext {
  app: FastifyInstance;
  db: AppDatabase;
  sfu: SfuManager;
  cluster: ClusterBus;
  gateway: RealtimeGateway;
  closeAll: () => Promise<void>;
}

export async function createServerApp(options?: {
  customSqlitePath?: string;
  logger?: boolean;
}): Promise<ServerContext> {
  const db = new AppDatabase(options?.customSqlitePath);
  await db.init();

  const cluster = new ClusterBus();
  await cluster.init();

  const sfu = new SfuManager();
  await sfu.init();

  const storage = new StorageService();
  const gateway = new RealtimeGateway(db, sfu, cluster);

  const app = Fastify({
    logger: options?.logger ?? !config.isProduction,
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Modern Defense-in-Depth HTTP Security Headers
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), payment=(), usb=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; connect-src 'self' ws: wss: https: http:;"
    );

    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps =
      config.isProduction ||
      req.protocol === 'https' ||
      (typeof forwardedProto === 'string' && forwardedProto.includes('https'));
    if (isHttps) {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
  });

  await app.register(websocket, {
    options: {
      maxPayload: 2 * 1024 * 1024,
    },
  });

  await registerApiRoutes(app, { db, storage, gateway });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const query = (req.query || {}) as { ticket?: string; token?: string };
    const authHeader = req.headers.authorization;
    const bearer =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : null;
    const ticket = query.ticket || null;
    const token = bearer || query.token || null;
    void gateway.handleConnection(socket, { ticket, token });
  });

  // Serve built official web frontend in production / unified mode
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Rota não encontrada' });
      }
      const indexHtml = path.join(config.webDistDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexHtml));
      }
      return reply.code(404).send({ error: 'Frontend não compilado' });
    });
  }

  const closeAll = async () => {
    gateway.close();
    await sfu.close();
    await cluster.close();
    await app.close();
    await db.close();
  };

  return { app, db, sfu, cluster, gateway, closeAll };
}

