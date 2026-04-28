import type { Client } from 'discord.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { startWatcher } from './discord/watcher.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function registerShutdownHandlers(client: Client): void {
    let isShuttingDown = false;

    const shutdown = (signal: NodeJS.Signals) => {
        if (isShuttingDown) {
            return;
        }
        isShuttingDown = true;

        logger.info({ signal }, 'Received shutdown signal, closing Discord client');
        client.destroy();
        process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function main() {
    logger.info(
        {
            dryRun,
            watchedChannelCount: env.DISCORD_WATCH_CHANNEL_IDS.length,
            portalUrl: env.PORTAL_API_URL,
        },
        'Starting portal-discord-bot'
    );

    if (dryRun) {
        logger.info('Dry run complete. Exiting without Discord login.');
        return;
    }

    const client = await startWatcher(false);
    registerShutdownHandlers(client);
}

main().catch((error) => {
    logger.fatal({ err: error }, 'Bot crashed during startup');
    process.exit(1);
});
