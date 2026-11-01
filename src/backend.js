import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Single place for calls that leave the machine. The webhook secret lives here
 * so it is never compiled into a browser bundle.
 */
async function post(path, payload, label) {
    if (!config.backendUrl) throw new Error('BACKEND_URL is not configured');

    const headers = { 'Content-Type': 'application/json' };
    if (config.backendSecret) headers['x-webhook-secret'] = config.backendSecret;

    const response = await fetch(`${config.backendUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
            `${label} responded ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
    }

    return response.status;
}

export async function updateMetadata(artist, title) {
    const status = await post('/api/station/nowplaying/update', { artist, title }, 'Backend');
    logger.info(`Now playing updated (${status}): ${artist || '-'} - ${title || '-'}`);
}

/**
 * Plays the role of the Facebook Live webhook so the OBS panel only talks to
 * the local agent: no secret in the bundle and no cross-origin request.
 */
export async function notifyFacebookLive(status, permalinkUrl) {
    const payload = {
        object: 'page',
        entry: [{
            changes: [{
                field: 'live_videos',
                value: { status, permalink_url: permalinkUrl },
            }],
        }],
    };

    const code = await post('/webhook/facebook', payload, 'Facebook webhook');
    logger.info(`Facebook live webhook sent (${status}) → HTTP ${code}`);
}
