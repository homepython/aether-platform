import fs from 'node:fs';
import path from 'node:path';

const webDist = path.resolve(import.meta.dirname, '../../web/dist');
const destRenderer = path.resolve(import.meta.dirname, '../renderer');

if (!fs.existsSync(webDist)) {
  throw new Error(`Diretório apps/web/dist não encontrado: ${webDist}`);
}

fs.rmSync(destRenderer, { recursive: true, force: true });
fs.cpSync(webDist, destRenderer, { recursive: true });
console.log('[Desktop] Renderer bundle sincronizado em apps/desktop/renderer');

