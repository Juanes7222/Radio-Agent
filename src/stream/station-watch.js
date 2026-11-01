import { logger } from '../logger.js';

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
// A single negative answer proves nothing: the station takes a few seconds to
// switch to the live input. Two in a row is already a real state.
const NEGATIVE_POLLS_BEFORE_REPORT = 2;

// Liquidsoap reports the source of the media it is airing. Any of these means
// the AutoDJ is playing, so the live input is not being mixed.
const AUTO_DJ_SOURCES = new Set(['songs', 'jingles', 'playlist']);

function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

async function fetchStation(baseUrl) {
    const response = await fetch(`${baseUrl}/api/nowplaying`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the station answered ${response.status}`);

    const body = await response.json();
    // AzuraCast returns a bare station when the instance hosts only one.
    return Array.isArray(body) ? body[0] ?? null : body;
}

/**
 * Whether the station is airing the audio this agent sends. A registered
 * source is not enough: the harbour accepts it before Liquidsoap mixes it,
 * and it also keeps the registration after the encoder is gone.
 */
function readAirStatus(station, streamerUser) {
    if (station?.live?.is_live !== true) {
        return { airing: false, reason: 'la emisora no tiene tu fuente en vivo' };
    }

    const source = String(station?.now_playing?.playlist_source ?? '');
    if (AUTO_DJ_SOURCES.has(source)) {
        return { airing: false, reason: 'la emisora sigue emitiendo el AutoDJ en vez de tu audio' };
    }

    const reported = normalize(station?.live?.streamer_name);
    const ours = normalize(streamerUser);
    if (reported && ours && reported !== ours) {
        return { airing: false, reason: `otra fuente está al aire: ${station.live.streamer_name}` };
    }

    return { airing: true, reason: null };
}

/**
 * Polls the station while a stream is live and exposes the verdict. Verification
 * is advisory: when the station cannot be read the answer is `null`, never a
 * false alarm.
 */
export function createStationWatcher({ baseUrl, streamerUser }) {
    let timer = null;
    let polling = false;
    let airing = null;
    let reason = null;
    let negativePolls = 0;

    async function poll() {
        if (!polling) return;

        try {
            const status = readAirStatus(await fetchStation(baseUrl), streamerUser);
            negativePolls = status.airing ? 0 : negativePolls + 1;

            if (status.airing || negativePolls >= NEGATIVE_POLLS_BEFORE_REPORT) {
                if (status.airing !== airing) {
                    logger.info(status.airing
                        ? 'station confirms the live audio is on air'
                        : `station says the live audio is not on air: ${status.reason}`);
                }
                airing = status.airing;
                reason = status.reason;
            }
        } catch (error) {
            // Not knowing is not a problem: only a contradicting answer is.
            if (airing !== null) logger.warn(`station air check failed: ${error.message}`);
            airing = null;
            reason = null;
            negativePolls = 0;
        }
    }

    return {
        start() {
            if (!baseUrl || polling) return;
            polling = true;
            void poll();
            timer = setInterval(poll, POLL_INTERVAL_MS);
            timer.unref?.();
        },

        stop() {
            polling = false;
            clearInterval(timer);
            timer = null;
            airing = null;
            reason = null;
            negativePolls = 0;
        },

        /** { airing: true | false | null, reason: string | null } */
        snapshot() {
            return { airing, reason };
        },
    };
}
