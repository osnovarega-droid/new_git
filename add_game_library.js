const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const client = new SteamUser({
    enablePicsCache: false,
});

const [, , login, password, sharedSecret, appIdsArg] = process.argv;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 5000;

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
let reconnectAttempts = 0;
let licenseRequestStarted = false;
let licenseRequestCompleted = false;

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

function doLogOn() {
    client.logOn({
        accountName: login,
        password,
        twoFactorCode: SteamTotp.getAuthCode(sharedSecret),
        machineName: `library_adder_${login}`,
    });
}

function requestLicenses() {
    if (isShuttingDown || licenseRequestStarted || licenseRequestCompleted) {
        return;
    }

    licenseRequestStarted = true;
    client.requestFreeLicense(appIds, (err, grantedPackageIDs, grantedAppIDs) => {
        licenseRequestStarted = false;

        if (err) {
            const isNoConnection = String(err?.message || err).toLowerCase().includes('noconnection');
            if (isNoConnection && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts += 1;
                console.error(`[${login}] requestFreeLicense failed: ${err?.message || err}. Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS / 1000}s...`);
                setTimeout(() => {
                    if (isShuttingDown || licenseRequestCompleted) {
                        return;
                    }
                    doLogOn();
                }, RECONNECT_DELAY_MS);
                return;
            }

            appIds.forEach((appId) => {
                console.log(`Не удалось добавить в библиотеку ${appId}`);
            });
            shutdown(3);
            return;
        }

        const grantedApps = Array.isArray(grantedAppIDs) ? grantedAppIDs : [];
        const grantedPackages = Array.isArray(grantedPackageIDs) ? grantedPackageIDs : [];

        const grantedSet = new Set(grantedApps);
        let successCount = 0;

        appIds.forEach((appId) => {
            if (grantedSet.has(appId)) {
                console.log(`Успешно добавил игру в библиотеку ${appId}`);
                successCount += 1;
            } else {
                console.log(`Не удалось добавить в библиотеку ${appId}`);
            }
        });

        if (successCount === 0 && grantedPackages.length === 0) {
            shutdown(4);
            return;
        }

        licenseRequestCompleted = true;
        shutdown(0);
    });
}

client.on('loggedOn', () => {
    reconnectAttempts = 0;
    client.setPersona(SteamUser.EPersonaState.Online);
    requestLicenses();
});

client.on('error', (err) => {
    console.error(`[${login}] Steam error: ${err?.message || err}`);
    shutdown(5);
});

client.on('disconnected', (eresult, msg) => {
    const reason = msg || eresult;
    const isNoConnection = String(reason).toLowerCase().includes('noconnection');
    if (!licenseRequestCompleted && isNoConnection && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts += 1;
        console.error(`[${login}] Disconnected: ${reason}. Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS / 1000}s...`);
        setTimeout(() => {
            if (isShuttingDown || licenseRequestCompleted) {
                return;
            }
            doLogOn();
        }, RECONNECT_DELAY_MS);
        return;
    }

    console.error(`[${login}] Disconnected: ${msg || eresult}`);
    shutdown(6);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

doLogOn();
