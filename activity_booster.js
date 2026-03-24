const https = require('https');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const client = new SteamUser();

const [, , login, password, sharedSecret, steamIdArg, minIntervalArg, maxIntervalArg] = process.argv;

if (!login || !password || !sharedSecret || !steamIdArg) {
    console.error('Usage: node activity_booster.js <login> <password> <shared_secret> <steamid> [min_minutes=60] [max_minutes=100]');
    process.exit(1);
}

const steamId = String(steamIdArg).trim();
const minIntervalMinutes = Math.max(1, Number.parseInt(minIntervalArg || '60', 10));
const maxIntervalMinutes = Math.max(minIntervalMinutes, Number.parseInt(maxIntervalArg || '100', 10));

let availableGameIds = [];
let rotateTimer = null;
let isShuttingDown = false;

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomGames(appIds, count = 2) {
    const pool = [...appIds];
    for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(count, pool.length));
}

function parseGamesFromHtml(html) {
    const rgGamesMatch = html.match(/var\s+rgGames\s*=\s*(\[[\s\S]*?\]);/);
    if (!rgGamesMatch) {
        return [];
    }

    try {
        const payload = JSON.parse(rgGamesMatch[1]);
        return payload
            .map((game) => Number.parseInt(game?.appid, 10))
            .filter((appid) => Number.isInteger(appid) && appid > 0);
    } catch (err) {
        console.error(`Failed to parse games JSON: ${err.message}`);
        return [];
    }
}

function fetchOwnedGames(steamIdValue, sessionId, steamLoginSecure) {
    const path = `/profiles/${steamIdValue}/games?tab=all`;

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'steamcommunity.com',
                path,
                method: 'GET',
                headers: {
                    Cookie: `sessionid=${sessionId}; steamLoginSecure=${steamLoginSecure};`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                },
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(parseGamesFromHtml(body));
                });
            }
        );

        req.on('error', (err) => reject(err));
        req.end();
    });
}

function scheduleNextRotate() {
    const nextMinutes = randInt(minIntervalMinutes, maxIntervalMinutes);
    const nextMs = nextMinutes * 60 * 1000;

    console.log(`Next rotation in ${nextMinutes} minutes`);
    rotateTimer = setTimeout(() => {
        if (isShuttingDown) {
            return;
        }
        startRandomActivity();
        scheduleNextRotate();
    }, nextMs);
}

function startRandomActivity() {
    const selected = pickRandomGames(availableGameIds, 2);
    if (selected.length === 0) {
        console.log('No games available for activity');
        return;
    }

    console.log(`Playing random appids: ${selected.join(', ')}`);
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(selected, true);
}

function shutdown(code = 0) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    if (rotateTimer) {
        clearTimeout(rotateTimer);
        rotateTimer = null;
    }

    try {
        client.gamesPlayed([]);
    } catch (_) {
        // noop
    }
    try {
        client.logOff();
    } catch (_) {
        // noop
    }

    process.exit(code);
}

client.on('loggedOn', () => {
    console.log(`[${login}] Logged on`);
    client.webLogOn();
});

client.on('webSession', async (sessionId, cookies) => {
    const steamLoginSecureCookie = (cookies || []).find((cookie) => cookie.startsWith('steamLoginSecure='));
    if (!steamLoginSecureCookie) {
        console.error('steamLoginSecure cookie not found');
        shutdown(3);
        return;
    }

    const steamLoginSecure = steamLoginSecureCookie.split('=').slice(1).join(';').split(';')[0];

    try {
        availableGameIds = await fetchOwnedGames(steamId, sessionId, steamLoginSecure);
        if (availableGameIds.length === 0) {
            console.error(`[${login}] Could not find any games on account`);
            shutdown(5);
            return;
        }

        console.log(`[${login}] Found ${availableGameIds.length} games`);
        startRandomActivity();
        scheduleNextRotate();
    } catch (err) {
        console.error(`[${login}] Failed to fetch game list: ${err.message}`);
        shutdown(6);
    }
});

client.on('error', (err) => {
    console.error(`[${login}] Steam error: ${err?.message || err}`);
    shutdown(4);
});

client.on('disconnected', (eresult, msg) => {
    console.error(`[${login}] Disconnected: ${msg || eresult}`);
    shutdown(2);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

client.logOn({
    accountName: login,
    password,
    twoFactorCode: SteamTotp.getAuthCode(sharedSecret),
    machineName: `booster_${login}`,
});
