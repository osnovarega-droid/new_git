const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const client = new SteamUser({
    enablePicsCache: true,
});

const [, , login, password, sharedSecret, steamIdArg, minIntervalArg, maxIntervalArg] = process.argv;

if (!login || !password || !sharedSecret || !steamIdArg) {
    console.error('Usage: node activity_booster.js <login> <password> <shared_secret> <steamid> [min_minutes=60] [max_minutes=100]');
    process.exit(1);
}


const minIntervalMinutes = Math.max(1, Number.parseInt(minIntervalArg || '60', 10));
const maxIntervalMinutes = Math.max(minIntervalMinutes, Number.parseInt(maxIntervalArg || '100', 10));

let availableGameIds = [];
let rotateTimer = null;
let isShuttingDown = false;
let startedPlaying = false;

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
    startedPlaying = true;
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
    client.setPersona(SteamUser.EPersonaState.Online);
    client.webLogOn();
});

client.on('ownershipCached', async () => {
    try {
        availableGameIds = client.getOwnedApps({
            excludeShared: true,
            excludeFree: true,
        });
 
        if (!Array.isArray(availableGameIds) || availableGameIds.length === 0) {
            availableGameIds = client.getOwnedApps({excludeShared: true}) || [];
        }

        if (availableGameIds.length === 0) { 
            console.error(`[${login}] Could not find any games on account`); 
            shutdown(5); 
            return; 
        } 

        console.log(`[${login}] Found ${availableGameIds.length} games`);
        startRandomActivity();
        scheduleNextRotate();
    } catch (err) {
        console.error(`[${login}] Failed to build owned app list: ${err.message}`);
        shutdown(6);
    }
});

client.on('webSession', () => {
    if (!startedPlaying) {
        console.log(`[${login}] Web session started`);
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
