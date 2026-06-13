import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { LiveScoreService } from './live-score.service.js';
import type { Env } from '../../config/env.validation.js';

/**
 * Registers the live-score cron job at startup — only when LIVE_SYNC_ENABLED.
 * The cron expression is configurable via LIVE_SYNC_CRON.
 */
@Injectable()
export class LiveScoreScheduler implements OnModuleInit {
  private readonly logger = new Logger(LiveScoreScheduler.name);
  private running = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly liveScore: LiveScoreService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('LIVE_SYNC_ENABLED', { infer: true })) {
      this.logger.log('Live-score sync disabled (LIVE_SYNC_ENABLED=false).');
      return;
    }

    const expression = String(
      this.config.get('LIVE_SYNC_CRON', { infer: true }),
    );
    const job = CronJob.from({
      cronTime: expression,
      onTick: () => {
        void this.tick();
      },
    });
    this.registry.addCronJob('live-score', job);
    job.start();
    this.logger.log(`Live-score sync enabled (cron: ${expression}).`);
    void this.tick();
  }

  private async tick(): Promise<void> {
    await this.runExclusive('live-score catch-up/window', async () => {
      await this.liveScore.syncMissingDueDates();
      await this.liveScore.syncActiveMatchWindow();
    });
  }

  private async runExclusive(
    label: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (this.running) {
      this.logger.warn(`Previous live-score task still running — skipping ${label}.`);
      return;
    }
    this.running = true;
    try {
      await task();
    } catch (err) {
      this.logger.warn(
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
