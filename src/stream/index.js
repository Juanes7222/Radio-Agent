import { config } from '../config.js';
import * as butt from '../butt.js';
import state from '../state.js';
import { getSettings } from '../settings.js';
import { CODECS, SAMPLE_RATES, resolveMount } from './ffmpeg.js';
import { listAudioDevices } from './devices.js';
import { isActive, shutdownEngine, startEngine, statusEngine, stopEngine } from './engine.js';

/** Read on every call: the panel can switch engines without a restart. */
export const engineName = () => config.streamEngine;

const usesFfmpeg = () => config.streamEngine === 'ffmpeg';

/**
 * One status shape for both engines so the OBS panel never branches on which
 * one is running.
 */
export async function status() {
    if (usesFfmpeg()) return statusEngine();

    const running = await butt.isRunning();
    if (!running) {
        state.isStreaming = false;
        state.isMuted = false;
    }

    return {
        engine: 'butt',
        state: state.isStreaming ? 'live' : 'idle',
        active: state.isStreaming,
        live: state.isStreaming,
        detail: null,
        configured: true,
    };
}

export async function start() {
    if (usesFfmpeg()) return startEngine();

    if (!(await butt.isRunning({ maxAgeMs: 0 }))) await butt.launch();
    await butt.connect();
    state.isStreaming = true;
    return status();
}

export async function stop() {
    if (usesFfmpeg()) return stopEngine();

    await butt.disconnect();
    state.isStreaming = false;
    state.isMuted = false;
    return status();
}

export function settingsView() {
    const settings = getSettings();

    return {
        engine: engineName(),
        settings,
        source: {
            host: config.azuracast.host,
            port: config.azuracast.port,
            mount: resolveMount(settings),
            user: config.azuracast.sourceUser,
            passwordConfigured: Boolean(config.azuracast.sourcePassword),
            tls: config.azuracast.tls,
        },
        configured: Boolean(config.azuracast.host && config.azuracast.sourcePassword),
        limits: {
            codecs: Object.keys(CODECS),
            sampleRates: [...SAMPLE_RATES],
            bitrateKbps: { min: 32, max: 320 },
            channels: [1, 2],
            gainDb: { min: -20, max: 20 },
        },
    };
}

export async function devices(options) {
    if (!usesFfmpeg()) return [];
    return listAudioDevices(options);
}

export function active() {
    return usesFfmpeg() ? isActive() : state.isStreaming;
}

export function shutdown() {
    if (usesFfmpeg()) shutdownEngine();
}
