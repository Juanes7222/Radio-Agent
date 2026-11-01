import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { HttpError } from '../http-error.js';
import { logger } from '../logger.js';
import { getSettings } from '../settings.js';
import { CODECS, buildArgs, classifyFailure, lastMeaningfulLine, logSettings, resolveMount } from './ffmpeg.js';
import { SourceError, createSourceClient } from './source-client.js';
import { createStationWatcher } from './station-watch.js';

const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const STOP_GRACE_MS = 2000;
const STABLE_AFTER_MS = 30000;

let child = null;
let source = null;
let state = 'idle';
let detail = null;
let attempts = 0;
let retryTimer = null;
let stableTimer = null;
let startedAt = null;
let liveAt = null;
let stderrTail = [];
let stopping = false;
let runId = 0;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const stationWatcher = createStationWatcher({
    baseUrl: config.stationStatusUrl,
    streamerUser: config.azuracast.sourceUser,
});

function setState(next, nextDetail = null) {
    state = next;
    detail = nextDetail;
}

export function isActive() {
    return state === 'starting' || state === 'live' || state === 'reconnecting';
}

function onStderr(chunk) {
    const lines = chunk.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return;
    stderrTail = [...stderrTail, ...lines].slice(-20);
}

/**
 * The stderr tail is the only evidence ffmpeg leaves about why a run ended, so
 * a drop without it cannot be diagnosed afterwards.
 */
function logStderrTail(context) {
    const lines = stderrTail.filter(Boolean).slice(-5);
    if (lines.length === 0) return;
    logger.warn(`${context} — ffmpeg stderr: ${lines.join(' | ')}`);
}

function describeSource(clientStats) {
    if (!clientStats) return 'no source connection';
    return `sent ${clientStats.bytesSent} bytes (${clientStats.kbps} kbps) in ${Math.round(clientStats.elapsedMs / 1000)}s`;
}

function closeSource() {
    const active = source;
    source = null;
    try { active?.close(); } catch { /* already gone */ }
}

function clearRunTimers() {
    clearTimeout(retryTimer);
    clearTimeout(stableTimer);
    retryTimer = null;
    stableTimer = null;
}

function markLive() {
    setState('live');
    liveAt = Date.now();
    logger.info(`stream is live (${Math.round((liveAt - startedAt) / 100) / 10}s)`);
    stationWatcher.start();

    // A stream that stayed up for a while has proven itself: give it a fresh
    // set of retries so a long session never exhausts them.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { attempts = 0; }, STABLE_AFTER_MS);
    stableTimer.unref?.();
}

function markDropped(message) {
    if (state === 'live') setState('reconnecting', message);
}

/**
 * Ends the current run and decides what happens next: a hard failure stops and
 * reports, a transient one backs off and restarts the whole pipeline.
 */
function finishRun(message, { fatal }) {
    clearTimeout(stableTimer);
    stableTimer = null;
    liveAt = null;
    stationWatcher.stop();

    if (fatal) {
        attempts = 0;
        setState('error', message);
        logger.error(`stream stopped: ${message}`);
        return;
    }

    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
        setState('error', `Se agotaron los reintentos: ${message}`);
        logger.error(`stream retries exhausted: ${message}`);
        return;
    }

    const waitMs = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    setState('reconnecting', message);
    logger.warn(`stream dropped (${message}); retry ${attempts}/${MAX_ATTEMPTS} in ${waitMs}ms`);

    retryTimer = setTimeout(() => {
        retryTimer = null;
        spawnFfmpeg();
    }, waitMs);
    retryTimer.unref?.();
}

/** Tears the current run down without letting its exit handler schedule a retry. */
function abortRun(run, message, { fatal }) {
    if (run !== runId) return;

    const clientStats = source?.stats();
    closeSource();

    logStderrTail(`run stopped: ${message} (source: ${describeSource(clientStats)})`);

    const spawned = child;
    child = null; // makes handleExit() ignore this exit
    if (spawned) {
        spawned.stdout?.removeAllListeners('data');
        try { spawned.kill('SIGKILL'); } catch { /* already gone */ }
    }

    stderrTail = [];
    finishRun(message, { fatal });
}

async function connectSource(run, settings) {
    if (!config.azuracast.host || !config.azuracast.sourcePassword) {
        abortRun(run, 'faltan AZURACAST_HOST o AZURACAST_SOURCE_PASSWORD en el .env del agente', { fatal: true });
        return;
    }

    const client = createSourceClient({
        host: config.azuracast.host,
        port: config.azuracast.port,
        mount: resolveMount(settings),
        user: config.azuracast.sourceUser,
        password: config.azuracast.sourcePassword,
        contentType: CODECS[settings.codec].contentType,
        useTls: config.azuracast.tls,
        name: config.azuracast.streamName,
        genre: config.azuracast.genre,
        website: config.azuracast.website,
        isPublic: config.azuracast.isPublic,
    });

    try {
        await client.open();
    } catch (error) {
        const fatal = error instanceof SourceError ? error.fatal : true;
        abortRun(run, error.message ?? String(error), { fatal });
        return;
    }

    if (run !== runId) {
        // A newer run (or a stop) happened while connecting.
        try { client.close(); } catch { /* already gone */ }
        return;
    }

    source = client;
    logger.info(`source connected to ${config.azuracast.host}:${config.azuracast.port}${resolveMount(settings)}`);

    client.onClose(() => {
        if (run !== runId || source !== client) return;
        if (stopping) return;
        closeSource();
        markDropped('el servidor cerró la conexión');
        abortRun(run, 'el servidor cerró la conexión', { fatal: false });
    });

    // The encoder was held back while the source connected: release the audio.
    child?.stdout.resume();
}

function spawnFfmpeg() {
    const settings = getSettings();

    let args;
    try {
        args = buildArgs(settings);
    } catch (error) {
        setState('error', `Configuración inválida: ${error.message}`);
        return;
    }

    const run = ++runId;
    if (attempts === 0) logSettings(settings);

    stopping = false;
    setState('starting');
    startedAt = Date.now();
    liveAt = null;
    stderrTail = [];

    const spawned = spawn(config.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child = spawned;
    spawned.stdout.pause(); // no audio is dropped while the source connects
    spawned.stderr.setEncoding('utf8');
    spawned.stderr.on('data', onStderr);

    spawned.stdout.on('data', chunk => {
        if (run !== runId || !source) return;
        source.write(chunk);
        if (state === 'starting') markLive();
    });

    spawned.on('error', error => {
        if (child === spawned) child = null;
        const message = error.code === 'ENOENT'
            ? `ffmpeg no está instalado o FFMPEG_PATH apunta mal ("${config.ffmpegPath}")`
            : error.message;
        abortRun(run, message, { fatal: true });
    });

    spawned.on('exit', (code, signal) => handleExit(spawned, code, signal));

    void connectSource(run, settings);
}

function handleExit(exited, code, signal) {
    if (child !== exited) return; // superseded, aborted or stopped

    child = null;
    closeSource();
    clearTimeout(stableTimer);
    stableTimer = null;
    liveAt = null;

    const tail = stderrTail.join('\n');
    const wasStopping = stopping;
    stopping = false;

    if (wasStopping) {
        stderrTail = [];
        setState('idle');
        return;
    }

    const { fatal, reason } = classifyFailure(tail);
    const message = reason ?? (lastMeaningfulLine(tail) || `ffmpeg terminó (código ${code ?? signal})`);

    logStderrTail(`ffmpeg exited (code ${code ?? signal}): ${message}`);
    stderrTail = [];

    finishRun(message, { fatal });
}

function requireTargetConfig() {
    if (!config.azuracast.host) {
        throw new HttpError(400, 'Falta AZURACAST_HOST en el .env del agente');
    }
    if (!config.azuracast.sourcePassword) {
        throw new HttpError(400, 'Falta AZURACAST_SOURCE_PASSWORD en el .env del agente');
    }
}

export async function startEngine() {
    if (isActive()) return statusEngine();

    const settings = getSettings();
    if (!settings.device) {
        throw new HttpError(400, 'Elegí un dispositivo de audio antes de transmitir');
    }

    requireTargetConfig();
    buildArgs(settings); // surface argument errors before spawning anything

    attempts = 0;
    spawnFfmpeg();
    return statusEngine();
}

export async function stopEngine() {
    clearRunTimers();
    stationWatcher.stop();
    attempts = 0;

    const active = child;
    if (!active) {
        stopping = false;
        closeSource();
        setState('idle');
        return statusEngine();
    }

    stopping = true;
    closeSource();

    const exited = new Promise(resolve => active.once('exit', resolve));
    active.kill('SIGTERM');
    await Promise.race([exited, delay(STOP_GRACE_MS)]);

    if (active.exitCode === null && active.signalCode === null) {
        try { active.kill('SIGKILL'); } catch { /* already gone */ }
        await Promise.race([exited, delay(500)]);
    }

    if (child === active) {
        child = null;
        setState('idle');
    }
    stopping = false;
    return statusEngine();
}

export function statusEngine() {
    const settings = getSettings();
    const clientStats = source?.stats();
    const air = state === 'live' ? stationWatcher.snapshot() : { airing: null, reason: null };

    return {
        engine: 'ffmpeg',
        state,
        active: isActive(),
        live: state === 'live',
        // A live stream that the station is not airing is reported as such:
        // sending bytes is not the same thing as being on air.
        detail: air.airing === false ? air.reason : detail,
        airing: air.airing,
        device: settings.device,
        codec: settings.codec,
        bitrateKbps: settings.bitrateKbps,
        channels: settings.channels,
        sampleRate: settings.sampleRate,
        gainDb: settings.gainDb,
        mount: resolveMount(settings),
        target: config.azuracast.host
            ? `${config.azuracast.host}:${config.azuracast.port}${resolveMount(settings)}`
            : null,
        configured: Boolean(config.azuracast.host && config.azuracast.sourcePassword),
        uptimeMs: liveAt ? Date.now() - liveAt : 0,
        attempts,
        pid: child?.pid ?? null,
        source: {
            connected: Boolean(clientStats?.ready),
            bytesSent: clientStats?.bytesSent ?? 0,
            kbps: clientStats?.kbps ?? 0,
        },
    };
}

/** Used by the fatal handlers: neither process may outlive the agent. */
export function shutdownEngine() {
    clearRunTimers();
    stationWatcher.stop();
    closeSource();

    if (child) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        child = null;
    }
    setState('idle');
}
