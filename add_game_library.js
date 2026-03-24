const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const client = new SteamUser({
    enablePicsCache: false,
});

const [, , login, password, sharedSecret, appIdsArg] = process.argv;

if (!login || !password || !sharedSecret || !appIdsArg) {
    console.error('Usage: node add_game_library.js <login> <password> <shared_secret> <app_ids_or_urls_csv>');
    console.error('Example: node add_game_library.js my_login my_pass my_secret "730,https://store.steampowered.com/app/730/CounterStrike_2/"');
    process.exit(1);
}

function extractAppId(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return null;
    }

    if (/^\d+$/.test(raw)) {
        const id = Number.parseInt(raw, 10);
        return Number.isInteger(id) && id > 0 ? id : null;
    }

    const match = raw.match(/\/app\/(\d+)/i);
    if (match) {
        const id = Number.parseInt(match[1], 10);
        return Number.isInteger(id) && id > 0 ? id : null;
    }

    return null;
}

const appIds = appIdsArg
    .split(',')
    .map((item) => extractAppId(item))
    .filter((id) => Number.isInteger(id) && id > 0)
    .filter((id, idx, arr) => arr.indexOf(id) === idx);

if (appIds.length === 0) {
    console.error('No valid app IDs found. Pass IDs or Steam store links separated by comma.');
    process.exit(2);
}

let isShuttingDown = false;

function shutdown(code = 0) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    try {
        client.logOff();
    } catch (_) {
        // noop
    }

    setTimeout(() => process.exit(code), 250);
}

client.on('loggedOn', () => {
    console.log(`[${login}] Logged on. Requesting free licenses for app IDs: ${appIds.join(', ')}`);
    client.setPersona(SteamUser.EPersonaState.Online);

    client.requestFreeLicense(appIds, (err, grantedAppIDs, grantedPackageIDs) => {
        if (err) {
            console.error(`[${login}] Failed to add game(s) to library: ${err.message || err}`);
            shutdown(3);
            return;
        }

        const grantedApps = Array.isArray(grantedAppIDs) ? grantedAppIDs : [];
        const grantedPackages = Array.isArray(grantedPackageIDs) ? grantedPackageIDs : [];

        if (grantedApps.length === 0 && grantedPackages.length === 0) {
            console.log(`[${login}] No licenses were granted. These apps may already be in the library or are not free-to-play.`);
            shutdown(4);
            return;
        }

        if (grantedApps.length > 0) {
            console.log(`[${login}] Added app IDs to library: ${grantedApps.join(', ')}`);
        }
        if (grantedPackages.length > 0) {
            console.log(`[${login}] Granted package IDs: ${grantedPackages.join(', ')}`);
        }

        shutdown(0);
    });
});

client.on('error', (err) => {
    console.error(`[${login}] Steam error: ${err?.message || err}`);
    shutdown(5);
});

client.on('disconnected', (eresult, msg) => {
    console.error(`[${login}] Disconnected: ${msg || eresult}`);
    shutdown(6);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

client.logOn({
    accountName: login,
    password,
    twoFactorCode: SteamTotp.getAuthCode(sharedSecret),
    machineName: `library_adder_${login}`,
});