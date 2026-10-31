import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { ServerPushEvent } from '@aether/shared';
import { config } from '../config.js';

export interface ClusterEnvelope {
  originNodeId: string;
  scope: 'all' | 'room' | 'user';
  targetId?: string;
  excludePeerId?: string;
  event: ServerPushEvent;
}

const CHANNEL_NAME = 'aether:cluster:events';

export class ClusterBus {
  private emitter = new EventEmitter();
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  async init(): Promise<void> {
    if (!config.redisUrl) return;

    this.pub = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

    await this.sub.subscribe(CHANNEL_NAME);
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL_NAME) return;
      try {
        const parsed = JSON.parse(raw) as ClusterEnvelope;
        if (parsed.originNodeId === config.nodeInstanceId) return;
        this.emitter.emit('remoteEvent', parsed);
      } catch (err) {
        console.error('[ClusterBus] Invalid message payload:', err);
      }
    });
  }

  async publish(envelope: Omit<ClusterEnvelope, 'originNodeId'>): Promise<void> {
    if (!this.pub) return;
    const full: ClusterEnvelope = {
      ...envelope,
      originNodeId: config.nodeInstanceId,
    };
    await this.pub.publish(CHANNEL_NAME, JSON.stringify(full));
  }

  onRemoteEvent(listener: (envelope: ClusterEnvelope) => void): void {
    this.emitter.on('remoteEvent', listener);
  }

  async close(): Promise<void> {
    if (this.sub) await this.sub.quit();
    if (this.pub) await this.pub.quit();
  }
}

