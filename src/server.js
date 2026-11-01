import express from 'express';
import { agentConfigView, updateAgentConfig } from './agent-config.js';
import * as backend from './backend.js';
import * as butt from './butt.js';
import { HttpError } from './http-error.js';
import { logger } from './logger.js';
import { saveSettings } from './settings.js';
import state from './state.js';
import * as stream from './stream/index.js';

const MAX_FIELD_LENGTH = 512;
const CORS_MAX_AGE_SECONDS = 86400;
const FACEBOOK_STATUSES = new Set(['live', 'live_stopped']);

/** Reads an optional text field, rejecting wrong types and oversized payloads. */
function readTextField(value, name) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);

    const text = value.trim();
    if (text.length > MAX_FIELD_LENGTH) {
        throw new HttpError(400, `${name} is too long (max ${MAX_FIELD_LENGTH} characters)`);
    }
    return text;
}

function isHttpUrl(value) {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function withCors(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
}

/**
 * Builds the HTTP application. `onRestart` is invoked once the response that
 * acknowledges the restart has been flushed to the client.
 */
export function createServer({ onRestart }) {
    const app = express();

    app.disable('x-powered-by');
    app.use(express.json({ limit: '16kb' }));
    app.use(withCors);

    app.get('/butt/status', async (req, res) => {
        const running = await butt.isRunning();
        if (!running) {
            state.isStreaming = false;
            state.isMuted = false;
        }
        res.json({ running, isStreaming: state.isStreaming, isMuted: state.isMuted });
    });

    app.post('/butt/launch', async (req, res) => {
        // User actions must never act on a cached answer.
        if (await butt.isRunning({ maxAgeMs: 0 })) return res.json({ launched: false, reason: 'already running' });
        await butt.launch();
        res.json({ launched: true });
    });

    app.post('/butt/start', async (req, res) => {
        if (!(await butt.isRunning({ maxAgeMs: 0 }))) await butt.launch();
        await butt.connect();
        state.isStreaming = true;
        res.json({ ok: true });
    });

    app.post('/butt/stop', async (req, res) => {
        await butt.disconnect();
        state.isStreaming = false;
        state.isMuted = false;
        res.json({ ok: true });
    });

    app.post('/butt/metadata', async (req, res) => {
        const body = req.body ?? {};
        const artist = readTextField(body.artist, 'artist');
        const title = readTextField(body.title, 'title');

        if (!artist && !title) throw new HttpError(400, 'artist or title required');

        await backend.updateMetadata(artist, title);
        res.json({ ok: true });
    });

    // Proxied so the browser bundle never carries the webhook secret.
    app.post('/facebook/notify', async (req, res) => {
        const body = req.body ?? {};
        const status = readTextField(body.status, 'status');
        const permalinkUrl = readTextField(body.permalink_url, 'permalink_url');

        if (!FACEBOOK_STATUSES.has(status)) {
            throw new HttpError(400, 'status must be "live" or "live_stopped"');
        }
        if (!isHttpUrl(permalinkUrl)) {
            throw new HttpError(400, 'permalink_url must be an http(s) URL');
        }

        try {
            await backend.notifyFacebookLive(status, permalinkUrl);
        } catch (error) {
            throw new HttpError(502, error.message);
        }

        res.json({ ok: true });
    });

    app.post('/restart', (req, res) => {
        logger.info('Restart requested');
        res.json({ restarting: true });
        res.once('finish', onRestart);
    });

    // --- Stream engine: same API whether it is ffmpeg or butt underneath.
    app.get('/stream/status', async (req, res) => {
        res.json(await stream.status());
    });

    app.post('/stream/start', async (req, res) => {
        res.json(await stream.start());
    });

    app.post('/stream/stop', async (req, res) => {
        res.json(await stream.stop());
    });

    app.get('/stream/settings', (req, res) => {
        res.json(stream.settingsView());
    });

    app.put('/stream/settings', async (req, res) => {
        if (stream.engineName() !== 'ffmpeg') {
            throw new HttpError(400, 'stream settings are only available with STREAM_ENGINE=ffmpeg');
        }
        // Changing the encoder mid-broadcast would cut the audio: refuse it.
        if (stream.active()) {
            throw new HttpError(409, 'no se puede cambiar la configuración mientras la transmisión está activa');
        }

        const body = req.body ?? {};
        if (typeof body !== 'object' || Array.isArray(body)) {
            throw new HttpError(400, 'settings must be an object');
        }

        const settings = saveSettings(body);
        res.json({ settings, status: await stream.status() });
    });

    // --- Runtime configuration: engine, target, paths and backend.
    app.get('/config', (req, res) => {
        res.json(agentConfigView());
    });

    app.put('/config', async (req, res) => {
        if (stream.active()) {
            throw new HttpError(409, 'no se puede cambiar la configuración mientras la transmisión está activa');
        }

        const body = req.body ?? {};
        res.json({ config: updateAgentConfig(body), status: await stream.status() });
    });

    app.get('/stream/devices', async (req, res) => {
        const devices = await stream.devices({ refresh: req.query.refresh === '1' });
        res.json({ devices });
    });

    app.use((req, res) => {
        res.status(404).json({ error: 'not found' });
    });

    // Single error funnel: Express 5 forwards rejected handlers here.
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);

        const status = Number.isInteger(error?.status) ? error.status : 500;
        const where = `${req.method} ${req.originalUrl}`;

        if (status >= 500) logger.error(`${where} failed: ${error?.message ?? error}`, error);
        else logger.warn(`${where} rejected: ${error?.message ?? error}`);

        res.status(status).json({ error: error?.message ?? 'internal error' });
    });

    return app;
}
