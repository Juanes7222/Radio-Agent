// Applied before anything else reads config: the panel's saved overrides win
// over the .env values.
import { loadAgentConfig } from './agent-config.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { engineName, shutdown as shutdownStream } from './stream/index.js';

const SHUTDOWN_GRACE_MS = 3000;

let server = null;
let shuttingDown = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})`);

    if (server) {
        const closed = new Promise(resolve => server.close(resolve));
        server.closeIdleConnections?.();
        // Keep-alive sockets would otherwise hold the process open forever.
        const forceClose = setTimeout(() => server.closeAllConnections?.(), 500);
        forceClose.unref();
        await Promise.race([closed, delay(SHUTDOWN_GRACE_MS)]);
    }

    // The encoder must not outlive the agent.
    shutdownStream();
    await logger.close();
    process.exit(code);
}

process.on('uncaughtException', error => {
    logger.fatal(`Uncaught exception: ${error?.message ?? error}`, error);
    shutdownStream();
    process.exit(1);
});

process.on('unhandledRejection', reason => {
    logger.fatal(
        `Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`,
        reason instanceof Error ? reason : null,
    );
    shutdownStream();
    process.exit(1);
});

process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));

loadAgentConfig();

const app = createServer({ onRestart: () => shutdown(1, 'restart requested') });

server = app.listen(config.port, () => {
    logger.info(`radio-agent listening on port ${config.port} (stream engine: ${engineName()})`);
});

server.on('error', error => {
    logger.fatal(`HTTP server error on port ${config.port}: ${error.message}`, error);
    process.exit(1);
});
