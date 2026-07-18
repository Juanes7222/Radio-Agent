import 'dotenv/config';
import express             from 'express';
import * as butt           from './butt.js';
import state               from './state.js';
import { logger } from './logger.js';

process.on('uncaughtException', err => {
    logger.error(`Uncaught Exception: ${err.message}`, err);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.get('/butt/status', async (req, res) => {
    const running = await butt.isRunning();
    if (!running) {
        state.isStreaming = false;
        state.isMuted     = false;
    }
    logger.info("Invoice status");
    res.json({ running, isStreaming: state.isStreaming, isMuted: state.isMuted });
});

app.post('/butt/launch', async (req, res) => {
    if (await butt.isRunning()) return res.json({ launched: false, reason: 'already running' });
    try {
        await butt.launch();
        res.json({ launched: true });
    } catch (err) {
        logger.error(`Failed to launch butt: ${err.message}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/butt/start', async (req, res) => {
    try {
        if (!(await butt.isRunning())) await butt.launch();
        await butt.connect();
        state.isStreaming = true;
        res.json({ ok: true });
    } catch (err) {
        logger.error(`Failed to start butt: ${err.message}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/butt/stop', async (req, res) => {
    try {
        await butt.disconnect();
        state.isStreaming = false;
        state.isMuted     = false;
        res.json({ ok: true });
    } catch (err) {
        logger.error(`Failed to stop butt: ${err.message}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/butt/metadata', async (req, res) => {
    const { artist = '', title = '' } = req.body;
    logger.info(`/butt/metadata called with artist="${artist}" title="${title}"`);
    if (!artist && !title) return res.status(400).json({ error: 'artist or title required' });
    try {
        await butt.updateMetadata(artist, title);
        res.json({ ok: true });
    } catch (err) {
        logger.error(`Failed to update metadata: ${err.message}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/restart', async (req, res) => {
    logger.info('Restart requested');

    res.json({
        restarting: true
    });

    setTimeout(() => {
        process.exit(1);
    }, 100);
});

app.listen(PORT, () => logger.info(`radio-agent running on port ${PORT}`));