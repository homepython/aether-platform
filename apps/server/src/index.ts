import { createServerApp } from './app.js';
import { config } from './config.js';

async function bootstrap() {
  const ctx = await createServerApp();

  const shutdown = async (signal: string) => {
    console.log(`\n[Aether Server] Recebido ${signal}. Encerrando com segurança...`);
    try {
      await ctx.closeAll();
      process.exit(0);
    } catch (err) {
      console.error('[Aether Server] Erro ao encerrar:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await ctx.app.listen({ host: config.host, port: config.port });
  console.log(
    `[Aether Server] Online em http://${config.host}:${config.port} (SFU Announced IP: ${config.mediasoup.announcedIp})`
  );
}

bootstrap().catch((err) => {
  console.error('[Aether Server] Falha crítica na inicialização:', err);
  process.exit(1);
});

