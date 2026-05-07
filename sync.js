/*
Sync is hash-based.
lastSyncedHash is the canonical record of the last known cloud state.
Cloud-newer detection is cloudHash !== lastSyncedHash.
Timestamps are used only for idle-return and auto-save timing.
*/


import { getToken, getGistId, setGistId, requireLogin, clearGistId, clearToken } from "./auth.js";
import { setWorkspace, saveState, getWorkspace, flattenWorkspace, migrateWorkspace, mergeWorkspace, createEmptyWorkspace, loadState, inflateWorkspace, encodeName, decodeName } from "./workspace.js";
import { renderSidebar, setSyncStatus, showNotification, showCountdownNotification, exportWorkspace, activeFileId, loadFile } from "./ui.js";
import { logger, LOG_LEVELS, formatDateNZ, getCallerName } from "./logger.js";
import { extractMetadata, applyMetadata, setMetadata, getMetadata} from "./workspace-metadata.js";   
import { updateSyncToggleButton } from "./binding.js";
import { deviceId } from "./device.js";

// Global guard to survive circular imports and module reloads
if (window.__cloudChangeHandled === undefined) {
    logger.warn("sync: guard-init", "__cloudChangeHandled was undefined → initializing to false");
    window.__cloudChangeHandled = false;
} else {
    logger.debugSyncing("sync: guard-init", `__cloudChangeHandled already exists: ${window.__cloudChangeHandled}`);
}



let lastSuccessfulSyncTime = 0;          // Local wall-clock time of last sync
let lastLocalEditTime = 0;     // Last time user typed anything
let syncInterval = 2 * 60 * 1000; // 2 minutes
let idleReturnThreshold = syncInterval * 2; // 4 minutes = “user returned”
export let lastSyncedHash = localStorage.getItem("lastSyncedHash") || null;
let syncEnabled = JSON.parse(localStorage.getItem("syncEnabled") ?? "true");
export let syncIntervalId = null;
let isSaving = false;
let lastActivityTime = Date.now(); 
const IDLE_THRESHOLD = 30_000; // 30 seconds
let cloudChangeHandled = false;
// mobile update ability functionality
export const settings = {
    mobileReadOnly: true,
    syncOverride: true
};

// When we have paths populated, chane to using paths, so as to avoind duplicate files. So wil lbecome EXCLUSION_PATHS
export const EXCLUSION_FILES = new Set(["__workspace.json", "workspace.json"]);

const GIST_API = "https://api.github.com/gists";

logger.debugSyncing("sync","sync.js loaded from:", import.meta.url);

function isMobileDevice() {
    return /Mobi|Android/i.test(navigator.userAgent);
}

export function isReadOnlyDevice() {
    return settings.mobileReadOnly && isMobileDevice();
}


async function getCurrentWorkspaceGist() {
    logger.debugSyncing("sync", () => "Running getCurrentWorkspaceGist(). CALLED BY: " + getCallerName("getCurrentWorkspaceGist"));

    if (!requireLogin()) {
        logger.info("sync: getCurrentWorkspaceGist", "Not logged in.");
        return null;
    }

    const gistId = getGistId();
    const githubToken = getToken();
    if (!gistId || !githubToken) {
        logger.info("sync: getCurrentWorkspaceGist", "No gistId or token found in localStorage.");
        disconnectFromGitHub("Cloud connection lost.");
        return null;
    }

    logger.info("sync: getCurrentWorkspaceGist", `Fetching gist with ID: ${gistId}`);

    try {
        const res = await githubFetch(`${GIST_API}/${gistId}`);

        if (res.status === 401) {
            logger.error("sync: getCurrentWorkspaceGist", "GitHub token invalid or expired. Disconnecting.");
            disconnectFromGitHub("Cloud token expired.");
            return null;
        }

        if (!res.ok) {
            const text = await res.text();
            logger.error("sync: getCurrentWorkspaceGist", `Failed to fetch gist (status: ${res.status})`);
            return null;
        }

        const data = await res.json();

        if (!data || !data.files) {
            logger.error("sync: getCurrentWorkspaceGist", "Response missing files property");
            return null;
        }   

        logger.info("sync: getCurrentWorkspaceGist", `Fetched gist with ID: ${data.id}, updated_at: ${formatDateNZ(data.updated_at)}`, { files: Object.keys(data.files) });

        return data;

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            throw error; // <-- propagate to sync engine
        }

        logger.error("sync: getCurrentWorkspaceGist", error);
        return null; // swallow only non-auth errors
    }
         
}

export function handleExpiredToken() {
    logger.debugSyncing("sync", () => "Running handleExpiredToken(). CALLED BY: " + getCallerName("handleExpiredToken"));
    logger.error("sync.token", "GitHub token expired — entering recovery mode");

    // 1. Emergency dump local workspace
    try {
        saveEmergencySnapshot("token-expired");
    } catch (e) {
        logger.error("sync.handleExpiredToken", "Emergency dump failed", e);
    }

    // 2. Clear credentials
    clearToken();
    clearGistId();

    // 3. Disable sync
    syncEnabled = false;

    // 4. Update UI
    updateSyncState();
    showNotification("warning", "Your GitHub session expired. Please log in again.");

    // 5. Stop further sync attempts
    disconnectFromGitHub("Token expired");
}

async function githubFetch(url, options = {}) {
    logger.debugSyncing("sync", () => "Running githubFetch(). CALLED BY: " + getCallerName("githubFetch"));
    const token = getToken(); // your existing getter

    const headers = {
        "Authorization": `token ${token}`,
        ...options.headers
    };

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {
        throw new Error("TOKEN_INVALID");
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GITHUB_ERROR ${res.status}: ${text}`);
    }

    return res;
}

export async function startSyncLoop() {
    logger.debugSyncing("sync", () => "Running startSyncLoop(). CALLED BY: " + getCallerName("startSyncLoop"));

    if (isReadOnlyDevice()) {
        logger.info("sync: startSyncLoop", "Start sync loop attempted on readonly device — ignoring");
        return;
    }  

    // temporarily disable starting sync loop if sync is disabled, to prevent any unexpected behavior while we work fixing the sync engine
    if (settings.syncOverride) {
        showNotification("info", "Sync loop is currently disabled");
        return;
    }

    if (!syncEnabled) {
        logger.debugSyncing("sync: startSyncLoop", "startSyncLoop() blocked — sync disabled");
        return;
    }

    if (syncIntervalId !== null) {
        logger.debugSyncing("sync: startSyncLoop", "startSyncLoop() called but loop already running");
        return;
    }    
    try {
        await runSyncCheck("startup");
        logger.debugSyncing("startSyncLoop called");
        // setup the “sync loop timer” This is the heartbeat that keeps the local and cloud workspaces in sync. It runs every 2 minutes, but only triggers a sync if something has changed in the cloud (or if we’ve been idle for a while and returned).
        syncIntervalId = setInterval(async () => {
            logger.debugSyncing("sync: startSyncLoop", "Periodic sync loop setup that fires runSyncCheck()");
            await runSyncCheck("periodic");
        }, syncInterval);
        updateSyncToggleButton();
    } catch (error) {
        logger.error("sync: startSyncLoop", error);
        return null;
    }        
}

export function setSyncEnabled(value) {
    logger.debugSyncing("sync", () => "Running setSyncEnabled(). CALLED BY: " + getCallerName("setSyncEnabled") + "  value: ", value);

    if (isReadOnlyDevice()) {
        logger.info("sync: setSyncEnabled", "Set sync enabled attempted on readonly device — ignoring");
        return;
    }

    // temporarily disable starting sync loop if sync is disabled, to prevent any unexpected behavior while we work fixing the sync engine
    if (settings.syncOverride) {
        syncEnabled = false;
        showNotification("info", "Sync loop is currently disabled");
        return;
    }

    syncEnabled = value;
    localStorage.setItem("syncEnabled", JSON.stringify(value));
}

export function getSyncEnabled() {
    if (settings.syncOverride) {
        return false;
    } else {
        return syncEnabled;
    }
}

export function stopSyncLoop() {
    logger.debugSyncing("sync", () => "Running stopSyncLoop(). CALLED BY: " + getCallerName("stopSyncLoop"));

    if (isReadOnlyDevice()) {
        logger.info("sync: stopSyncLoop", "Stop sync toggle attempted on readonly device — ignoring");
        return;
    }    

    try {      
        if (syncIntervalId !== null) {
            clearInterval(syncIntervalId);
            syncIntervalId = null;
            logger.debugSyncing("stopSyncLoop:", syncIntervalId);
            updateSyncToggleButton();
        }
    } catch (error) {
        logger.error("sync: stopSyncLoop", error);
        return null;
    }           
}

export function toggleSyncLoop() {
    logger.debugSyncing("sync", () => "Running toggleSyncLoop(). CALLED BY: " + getCallerName("toggleSyncLoop")); 

    if (isReadOnlyDevice()) {
        logger.info("sync: toggleSyncLoop", "Sync toggle attempted on readonly device — ignoring");
        return;
    }

    // temporarily disable starting sync loop if sync is disabled, to prevent any unexpected behavior while we work fixing the sync engine
    if (getSyncEnabled() === false) {
        stopSyncLoop();
        return;
    }

    if (syncIntervalId === null) {
        startSyncLoop();
        logger.info("sync", "toggleSyncLoop → started");
    } else {
        stopSyncLoop();
        logger.info("sync", "toggleSyncLoop → stopped");
    }
}


// re-check the token immediately after wake to handle cases where GitHub token becomes invalid after laptop suspend
export async function bindVisibilityEvents() {
    logger.debugSyncing("sync", () => "Running bindVisibilityEvents(). CALLED BY: " + getCallerName("bindVisibilityEvents"));

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            runSyncCheck("resume");
        }
    });
}

export function bindActivityEvents() {
    logger.debugSyncing("sync", () => "Running bindActivityEvents(). CALLED BY: " + getCallerName("bindActivityEvents"));
    
    if (isReadOnlyDevice()) {
        logger.info("sync: bindActivityEvents", "Binding activity events attempted on readonly device — ignoring");
        return;
    } 

    document.addEventListener("keydown", markActivity);
    document.addEventListener("mousemove", markActivity);
    document.addEventListener("mousedown", markActivity);
    document.addEventListener("touchstart", markActivity);
    document.addEventListener("focus", markActivity);
}

function markActivity() {
    if (isReadOnlyDevice()) return;
    
    const now = Date.now();
    const wasIdle = (now - lastActivityTime) > IDLE_THRESHOLD;
    lastActivityTime = now;

    if (wasIdle) {
        runSyncCheck("resume");
    }
}

function setConnectionButtonState(connected) {
    logger.debugSyncing("sync", () => "Running setConnectionButtonState(). CALLED BY: " + getCallerName("setConnectionButtonState"));
    const loginBtn = document.getElementById("github-login");
    if (!loginBtn) {
        logger.info("sync: setConnectionButtonState", "Button 'github-login' not found");
        return;
    }

    if (connected) {
        loginBtn.textContent = "Connected to Cloud";
        loginBtn.classList.add("connected");
        loginBtn.classList.remove("github-login-needed");
    } else {
        loginBtn.textContent = "Sign in to Cloud";
        loginBtn.classList.add("github-login-needed");
        loginBtn.classList.remove("connected");
    }
}

function bindReconnectLink() {
    // Delay ensures the notification HTML is in the DOM
    logger.debugSyncing("sync", () => "Running bindReconnectLink(). CALLED BY: " + getCallerName("bindReconnectLink"));
    setTimeout(() => {
        const link = document.getElementById("reconnect-link");
        if (!link) {
            logger.info("sync: bindReconnectLink", "Link 'reconnect-link' not found");
            return;
        }        

        link.addEventListener("click", (e) => {
            e.preventDefault();
            const btn = document.getElementById("github-login");
            if (btn) btn.click();
        });
    }, 0);
}

export function disconnectFromGitHub(message) {
    logger.debugSyncing("sync", () => "Running disconnectFromGitHub(). CALLED BY: " + getCallerName("disconnectFromGitHub"));
    setSyncStatus("error", "Disconnected");
    setConnectionButtonState(false);
    showNotification("error",`${message} <a href="#" id="reconnect-link">Reconnect</a>.`);
    bindReconnectLink();
    stopSyncLoop();
}

function connectToGitHub() {
    logger.debugSyncing("sync", () => "Running connectToGitHub(). CALLED BY: " + getCallerName("connectToGitHub"));
    setSyncStatus("error", "Disconnected");
    setSyncStatus("synced", "Connected");
    setConnectionButtonState(true);
    showNotification("success", "Connected to cloud");
}

export async function runSyncCheck(reason) {
    logger.debugSyncing("sync: runSyncCheck", () => "Running runSyncCheck (start). CALLED BY: " + getCallerName("runSyncCheck")," (reason: " + reason + ")");

    if (!syncEnabled) {
        logger.debugSyncing("sync.runSyncCheck", `Skipped — sync disabled`);
        return;
    }
    if (isReadOnlyDevice() || !getSyncEnabled()) { return; }

    try {    
        const token = getToken();
        let gistId = getGistId();
        let syncDecision = "unknown";

        // ------------------------------------------------------------
        // LOGIN: token exists but no gistId → adopt or create gist
        // ------------------------------------------------------------
        if (reason === "login" && token && !gistId) {
            logger.debugSyncing("sync.runSyncCheck", "Token exists but no gistId — adopting or creating gist");

            const newId = await adoptOrCreateGist();
            if (!newId) {
                logger.error("sync.runSyncCheck", "Failed to adopt or create gist");
                return;
            }

            gistId = newId;
            syncDecision = "adopt-cloud-baseline";
        }
        else if (!token || !gistId) {
            logger.error("sync.runSyncCheck", "Missing token or gistId — stopping sync.");
            disconnectFromGitHub("Cloud connection lost.");
            return;
        }

        // ------------------------------------------------------------
        // LOGIN: token exists AND gistId exists → reconcile local vs cloud
        // Caters for expired tokens
        // ------------------------------------------------------------
        if (reason === "login" && token && gistId) {
            logger.debugSyncing("sync.runSyncCheck", "Login with existing gistId — performing reconciliation");

            // Load cloud workspace            
            const cloudWorkspace = await loadWorkspaceFromGist();

            if (!cloudWorkspace || !Array.isArray(cloudWorkspace.flat)) {
                logger.error("sync.runSyncCheck", "Cloud workspace invalid during login reconciliation");
                return;
            }

            const cloudFlat = cloudWorkspace.flat;
            const cloudHash = await computeWorkspaceHash(cloudFlat);

            // Load local workspace
            const localTree = loadState();
            const localFlat = flattenWorkspace(localTree);
            const localHash = await computeWorkspaceHash(localFlat);

            logger.debugSyncing(
                "sync.runSyncCheck",
                `Login reconciliation → local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}`
            );

            if (localHash !== cloudHash) {
                if (localHash !== cloudHash && localHash !== lastSyncedHash) {
                    logger.debugSyncing("sync.runSyncCheck", "Local is newer → pushing to cloud");
                    try {
                        await saveWorkspaceToGist();
                    } catch (err) {
                        if (err.message === "TOKEN_INVALID") {
                            handleExpiredToken();
                            return;
                        }
                        throw err;
                    }

                } else {
                    logger.debugSyncing("sync.runSyncCheck", "Cloud is newer → pulling to local");
                    await applyCloudWorkspace();
                }
            } else {
                logger.debugSyncing("sync.runSyncCheck", "Login reconciliation: hashes match — no action needed");
            }

            // After reconciliation, update baseline
            lastSyncedHash = cloudHash;
            localStorage.setItem("lastSyncedHash", cloudHash);
            updateSyncState();

            logger.debugSyncing("sync.runSyncCheck", "Login reconciliation complete");
            return;
        }

    

        // ------------------------------------------------------------
        // If local workspace is empty → load cloud
        // ------------------------------------------------------------
        if (gistId && workspaceIsEmpty()) {
            logger.debugSyncing("sync.runSyncCheck", "Workspace empty — loading from cloud");
            await applyCloudWorkspace();
            syncDecision = "load-cloud";
        }

        const now = Date.now();
        const idleReturn = now - lastSuccessfulSyncTime > idleReturnThreshold;

        logger.debugSyncing("sync.runSyncCheck",
            `Idle return: ${idleReturn} (last successful sync: ${new Date(lastSuccessfulSyncTime).toISOString()})`
        );

        // ------------------------------------------------------------
        // Load cloud workspace (flat model)
        // ------------------------------------------------------------        
        const cloudWorkspace = await loadWorkspaceFromGist();

        if (!cloudWorkspace || !Array.isArray(cloudWorkspace.flat)) {
            logger.error("sync.runSyncCheck", "Cloud workspace invalid");
            return;
        }

        const cloudFlat = cloudWorkspace.flat;
        const cloudHash = await computeWorkspaceHash(cloudFlat);

        // ------------------------------------------------------------
        // Load local workspace (flat model)
        // ------------------------------------------------------------
        const localTree = loadState();
        const localFlat = flattenWorkspace(localTree);
        const localHash = await computeWorkspaceHash(localFlat);

        logger.debugSyncing(
            "sync.runSyncCheck",
            `Hash comparison → local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${lastSyncedHash?.slice(0,8)}`
        );

        // ------------------------------------------------------------
        // First-time sync: adopt cloud hash
        // ------------------------------------------------------------
        if (lastSyncedHash === null) {
            logger.debugSyncing("sync.runSyncCheck", "No lastSyncedHash — adopting cloud hash as baseline");

            lastSyncedHash = cloudHash;
            localStorage.setItem("lastSyncedHash", cloudHash);
            updateSyncState();

            syncDecision = "adopt-cloud-baseline";
            logger.debugSyncing(
                "sync.summary",
                `cycle → reason=${reason}, local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${cloudHash.slice(0,8)}, decision=${syncDecision}`
            );
            return;
        }

        // ------------------------------------------------------------
        // Resume logic: skip if nothing changed
        // ------------------------------------------------------------
        if (reason === "resume") {
            const nothingChanged =
                localHash === lastSyncedHash &&
                cloudHash === lastSyncedHash;

            if (nothingChanged) {
                logger.debugSyncing("sync.runSyncCheck", "Resume: nothing changed — skipping sync");

                updateSyncState();
                syncDecision = "resume-skip";

                logger.debugSyncing(
                    "sync.summary",
                    `cycle → reason=${reason}, local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${lastSyncedHash.slice(0,8)}, decision=${syncDecision}`
                );
                return;
            }
        }

        // ------------------------------------------------------------
        // Cloud is newer → trigger cloud-change handler
        // ------------------------------------------------------------
        if (cloudHash !== lastSyncedHash) {
            logger.debugSyncing("sync.runSyncCheck", "Cloud is newer — triggering cloud-change handler");

            syncDecision = "cloud-newer";

            logger.debugSyncing(
                "sync.summary",
                `cycle → reason=${reason}, local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${lastSyncedHash.slice(0,8)}, decision=${syncDecision}`
            );

            return handleCloudChange({ id: gistId }, idleReturn);
        }

        // ------------------------------------------------------------
        // Everything matches → update sync timestamp + maybe auto-save
        // ------------------------------------------------------------
        logger.debugSyncing("sync.runSyncCheck", "Everything matches — updating sync timestamp");

        updateSyncState();
        maybeAutoSave();

        syncDecision = "nothing-changed";

        // ------------------------------------------------------------
        // FINAL SUMMARY
        // ------------------------------------------------------------
        logger.debugSyncing(
            "sync.summary",
            `cycle → reason=${reason}, local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${lastSyncedHash.slice(0,8)}, decision=${syncDecision}`
        );

        logger.debugSyncing("sync.runSyncCheck", "runSyncCheck end");
    }
    catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }

        logger.error("sync.runSyncCheck", "Unexpected error", err);
    }        
}


function workspaceIsEmpty() {
    const ws = getWorkspace();   // you already have this
    return !Array.isArray(ws) || ws.length === 0;
}

function updateSyncState() {
    logger.debugSyncing("sync", () => "Running updateSyncState(). CALLED BY: " + getCallerName("updateSyncState"));
    // Only updates timing — never the hash.
    lastSuccessfulSyncTime = Date.now();
}

async function handleCloudChange(latest, idleReturn) {
    logger.debugSyncing("sync: handleCloudChange", () => "Running handleCloudChange(). CALLED BY: " + getCallerName("handleCloudChange"));
    logger.debugSyncing("sync: handleCloudChange", `cloudChangeHandled = ${window.__cloudChangeHandled}`);

    if (isReadOnlyDevice() || !getSyncEnabled()) { 
        logger.debugSyncing("sync: handleCloudChange", "Skipping handleCloudChange — readonly device or sync disabled");
        return; 
    }    
    
    // Prevent duplicate dialogs or duplicate cloud-apply
    if (window.__cloudChangeHandled) {
        logger.debugSyncing("sync: handleCloudChange", "Skipping handleCloudChange — already handled this session");
        return;
    }

    // ⭐ IMPORTANT: Mark as handled *immediately* so no second dialog can appear
    window.__cloudChangeHandled = true;

    const now = Date.now();
    const recentlyTyped = (now - lastLocalEditTime) < 30_000;
    const countdown = recentlyTyped ? 30 : 10;

    showCountdownNotification({
        countdown,

        onConfirm: async () => {
            // (Guard already set above — do NOT move it back here)

            // --- SAFETY GUARD: ensure we have a valid gist reference ---
            if (!latest || !latest.id) {
                logger.error("sync: handleCloudChange", "Invalid latest gist object:", latest);
                showNotification("error", "Cloud sync failed — invalid gist reference");
                return;
            }

            // Ensure local gistId is correct
            setGistId(latest.id);

            // --- Load cloud workspace (flat list) ---
            let cloudWorkspace;
            try {
                cloudWorkspace = await loadWorkspaceFromGist();
            } catch (err) {
                if (err.message === "TOKEN_INVALID") {
                    handleExpiredToken();
                    return;
                }
                throw err;
            }

            if (!cloudWorkspace || !Array.isArray(cloudWorkspace.flat)) {
                logger.error("sync: handleCloudChange", "Cloud workspace invalid");
                return;
            }

            const flatList = cloudWorkspace.flat;

            // --- Inflate flat list → hierarchical tree ---
            const tree = inflateWorkspace(flatList);

            // --- Apply cloud workspace locally ---
            setWorkspace(tree);
            saveState();

            // --- Compute new cloud hash using the flat list ---
            lastSyncedHash = await computeWorkspaceHash(flatList);
            localStorage.setItem("lastSyncedHash", lastSyncedHash);
            lastSuccessfulSyncTime = Date.now();

            logger.debugSyncing(
                "sync: handleCloudChange",
                `Cloud accepted. Updated lastSyncedHash: ${lastSyncedHash}`
            );
        },

        onCancel: () => {
            // (Guard already set above — do NOT move it back here)
            showNotification(
                "warning",
                "Cloud version is newer. Saving now will overwrite it."
            );
        }
    });

    logger.debugSyncing("sync: handleCloudChange", "handleCloudChange end");

}


export function buildCanonicalSnapshot(flat) {
    logger.debugSyncing("sync", () => "Running buildCanonicalSnapshot(). CALLED BY: " + getCallerName("buildCanonicalSnapshot"));

    // Defensive: ensure flat is an object
    if (!Array.isArray(flat)) {
        logger.error("sync", "buildCanonicalSnapshot expected flat array:", flat);
        return { version: 1, flat: [] };
    }


    // Convert object → array of entries
    const entries = flat.map(f => ({
        name: f.path,
        content: f.content || ""
    }));

    // Defensive: ensure flat is an array of { path, content }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    return {
        version: 1,
        flat: entries
    };
}



async function sha256(str) {
    logger.debugSyncing("sync", () => "Running sha256(). CALLED BY: " + getCallerName("sha256"));
    // Encode string as UTF-8
    const encoder = new TextEncoder();
    const data = encoder.encode(str);

    // Hash the data
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    // Convert ArrayBuffer → hex string
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

    return hashHex;
}

export async function computeWorkspaceHash(flat) {
    logger.debugSyncing("sync", () => "Running computeWorkspaceHash(). CALLED BY: " + getCallerName("computeWorkspaceHash"));

    // Must be a flat ARRAY of { path, content }
    if (!Array.isArray(flat)) {
        logger.error("sync", "computeWorkspaceHash expected flat array, received:", flat);
        flat = [];
    }

    // Build canonical snapshot from flat array
    const snapshot = {
        version: 1,
        files: flat
            .map(f => ({
                path: f.path,
                content: f.content || ""
            }))
            .sort((a, b) => a.path.localeCompare(b.path))
    };

    const json = JSON.stringify(snapshot);
    const hash = await sha256(json);

    logger.debugSyncing("sync", `computeWorkspaceHash → ${hash}`);
    return hash;
}


export async function reconcileLocalAndCloud(localTree) {
    logger.debugSyncing("sync: reconcileLocalAndCloud", () => "Running reconcileLocalAndCloud(). CALLED BY: " + getCallerName("reconcileLocalAndCloud"));

    if (!syncEnabled) {
        logger.debugSyncing("sync: reconcileLocalAndCloud", "reconcileLocalAndCloud() skipped — sync disabled");
        return;
    }

    // SAFETY FIX:
    // Do NOT convert null → [].
    // Null means "no local workspace exists".
    const hasLocal = Array.isArray(localTree) && localTree.length > 0;

    let cloudMeta;
    try {
        cloudMeta = await getLatestWorkspaceGistMeta();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    }

    const lastSyncedHash = localStorage.getItem("lastSyncedHash");

    // ------------------------------------------------------------
    // CASE 1: No cloud gist exists yet
    // ------------------------------------------------------------
    if (!cloudMeta) {
        logger.debugSyncing("sync: reconcileLocalAndCloud", "CASE 1: No cloud gist exists yet");

        if (!hasLocal) {
            // No local, no cloud → create empty workspace
            const fresh = createEmptyWorkspace();
            saveState(fresh);

            try {
                await saveWorkspaceToGist();
            } catch (err) {
                if (err.message === "TOKEN_INVALID") {
                    handleExpiredToken();
                    return;
                }
                throw err;
            }


            const freshFlat = flattenWorkspace(fresh);
            const freshHash = await computeWorkspaceHash(freshFlat);
            localStorage.setItem("lastSyncedHash", freshHash);
            return;
        }

        // Local exists, cloud doesn't → push local to cloud
        try {
            await saveWorkspaceToGist();
        } catch (err) {
            if (err.message === "TOKEN_INVALID") {
                handleExpiredToken();
                return;
            }
            throw err;
        }


        const localFlat = flattenWorkspace(localTree);
        const localHash = await computeWorkspaceHash(localFlat);
        localStorage.setItem("lastSyncedHash", localHash);
        return;
    }

    // ------------------------------------------------------------
    // CASE 2: Cloud exists → load cloud workspace
    // ------------------------------------------------------------    
    let cloud;
    try {
        cloud = await loadWorkspaceFromGist();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    }    

    if (!cloud || !Array.isArray(cloud.flat)) {
        logger.error("sync: reconcileLocalAndCloud", "Cloud load failed or returned invalid structure");
        return;
    }
    logger.debugSyncing("sync: reconcileLocalAndCloud", "CASE 2: Cloud exists → load cloud workspace");

    const cloudFlat = cloud.flat;
    const cloudTree = inflateWorkspace(cloudFlat);
    const cloudMetadata = cloud.metadata || [];

    // ------------------------------------------------------------
    // Compute structural hashes (FLAT MODEL)
    // ------------------------------------------------------------
    const localFlat = hasLocal ? flattenWorkspace(localTree) : [];
    const localHash = await computeWorkspaceHash(localFlat);
    const cloudHash = await computeWorkspaceHash(cloudFlat);

    logger.debugSyncing(
        "sync: reconcileLocalAndCloud",
        `Hash comparison → local=${localHash.slice(0,8)}, cloud=${cloudHash.slice(0,8)}, lastSynced=${lastSyncedHash?.slice(0,8)}`
    );


    // ------------------------------------------------------------
    // CASE 3: Local and cloud match → nothing to do
    // ------------------------------------------------------------
    // Case 3 should never appear because:  local and cloud representations are structurally different (tree vs flat, ordering differences, migration differences), their hashes will never be identical. However, we keep this case here as a sanity check and safety guard: if the hashes do match, it means the local and cloud workspaces are actually identical in content, so we can safely skip any merging or conflict resolution and just adopt the cloud hash as the new baseline.
    if (hasLocal && localHash === cloudHash) {
        logger.debugSyncing("sync: reconcileLocalAndCloud", "CASE 3: Local and cloud match → nothing to do");
        const migrated = migrateWorkspace(localTree);
        saveState(migrated);
        localStorage.setItem("lastSyncedHash", localHash);
        return;
    }

    // ------------------------------------------------------------
    // CASE 4: Cloud changed since last sync → cloud wins
    // ------------------------------------------------------------
    if (cloudHash !== lastSyncedHash) {
        logger.debugSyncing("sync: reconcileLocalAndCloud", "CASE 4: Cloud changed since last sync → cloud wins");
        const merged = mergeWorkspace(localTree || [], cloudTree, cloudMetadata);
        const migrated = migrateWorkspace(merged);

        saveState(migrated);
        localStorage.setItem("lastSyncedHash", cloudHash);
        return;
    }

    // ------------------------------------------------------------
    // CASE 5: Local changed, cloud didn’t → local wins
    // ------------------------------------------------------------
    logger.debugSyncing("sync: reconcileLocalAndCloud", "CASE 5: Local changed, cloud didn’t → local wins");

    const merged = mergeWorkspace(localTree || [], cloudTree, cloudMetadata);
    const migrated = migrateWorkspace(merged);

    saveState(migrated);
    try {
        await saveWorkspaceToGist();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    }


    const newFlat = flattenWorkspace(migrated);
    const newHash = await computeWorkspaceHash(newFlat);
    localStorage.setItem("lastSyncedHash", newHash);

    logger.debugSyncing("sync: reconcileLocalAndCloud", "reconcileLocalAndCloud end");

}

async function getLatestWorkspaceGistMeta() {
    logger.debugSyncing("sync", () => "Running getLatestWorkspaceGistMeta(). CALLED BY: " + getCallerName("getLatestWorkspaceGistMeta"));
    const gistId = getGistId();
    const token = getToken();

    if (!gistId || !token) {
        logger.info("sync: getLatestWorkspaceGistMeta", "No gistId or token found.");
        return null;
    }

    try {
        const res = await githubFetch(`${GIST_API}/${gistId}`);

        if (res.status === 401) {
            logger.error("sync: getLatestWorkspaceGistMeta", "Token invalid or expired.");
            disconnectFromGitHub("Cloud token expired.");
            return null;
        }

        if (!res.ok) {
            const text = await res.text();
            logger.error("sync: getLatestWorkspaceGistMeta", `Failed to fetch gist metadata: ${res.status}`, text);
            return null;
        }

        const data = await res.json();

        // Extract hash from __workspace.json if present
        let cloudHash = null;
        if (data.files["__workspace.json"]) {
            try {
                const parsed = JSON.parse(data.files["__workspace.json"].content);
                cloudHash = parsed.hash || null;
            } catch (err) {
                logger.error("sync: getLatestWorkspaceGistMeta", "Failed to parse __workspace.json", err);
            }
        }

        return {
            id: data.id,
            updatedAt: data.updated_at,
            hash: cloudHash,
            files: Object.keys(data.files)
        };

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            throw error; // <-- propagate to sync engine
        }

        logger.error("sync: getLatestWorkspaceGistMeta", "Network or fetch error", err);
        return null; // swallow only non-auth errors
    }


}


async function maybeAutoSave() {
    logger.debugSyncing("sync", () => "Running maybeAutoSave(). CALLED BY: " + getCallerName("maybeAutoSave"));

    // --- Compute local hash using the flat model ---
    const localTree = loadState();
    const localFlat = flattenWorkspace(localTree);
    const localHash = await computeWorkspaceHash(localFlat);


    // --- No local changes since last sync ---
    if (localHash === lastSyncedHash) {
        logger.info("sync: maybeAutoSave", "No local changes found");
        return;
    }

    // --- Do not auto-save if cloud is newer ---
    if (await cloudHashChanged()) {
        logger.info("sync: maybeAutoSave", "Cloud is newer — auto-save skipped");
        return;
    }

    // --- Safe to auto-save ---
    logger.info("sync: maybeAutoSave", "Local changes detected — auto-saving");
    try {
        await saveWorkspaceToGist();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    }

}


async function cloudHashChanged() {
    logger.debugSyncing("sync", () => "Running cloudHashChanged(). CALLED BY: " + getCallerName("cloudHashChanged"));

    const latest = await getCurrentWorkspaceGist();
    if (!latest) {
        logger.info("sync: cloudHashChanged", "Latest Gist workspace not found");
        return false;
    }

    // Load cloud workspace using the flat model
    let cloudWorkspace;
    try {
        cloudWorkspace = await loadWorkspaceFromGist();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    } 

    if (!cloudWorkspace || !Array.isArray(cloudWorkspace.flat)) {
        logger.error("sync: cloudHashChanged", "Cloud workspace invalid");
        return false;
    }

    const cloudHash = await computeWorkspaceHash(cloudWorkspace.flat);
    logger.debugSyncing(
        "sync",
        "cloudHashChanged → cloudHash:",
        cloudHash,
        "lastSyncedHash:",
        lastSyncedHash
    );

    return cloudHash !== lastSyncedHash;
}



window.debugCloud = async () => {
    logger.debugSyncing("sync", () => "Assigning window.debugCloud. CALLED BY: " + getCallerName("debugCloud"));

    const latest = await getNewestGistAcrossAccount();
    if (!latest) {
        logger.info("sync: debugCloud", "No gist found when fetching newest gist across account.");
        return;
    }

    logger.info(
        "sync: debugCloud",
        `Fetched newest gist across account (ID: ${latest.id}, updated_at: ${formatDateNZ(latest.updated_at)}, files: ${Object.keys(latest.files).join(", ")})`
    );

    // Load the workspace using the flat model
    let cloudWorkspace;
    try {
        cloudWorkspace = await loadWorkspaceFromGist();
    } catch (err) {
        if (err.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return;
        }
        throw err;
    } 
        
    if (!cloudWorkspace || !Array.isArray(cloudWorkspace.flat)) {
        logger.error("sync: debugCloud", "Cloud workspace invalid");
        return;
    }

    const cloudHash = await computeWorkspaceHash(cloudWorkspace.flat);
    logger.info("sync: debugCloud", `Computed cloudHash for newest gist: ${cloudHash}`);
};


export async function saveWorkspaceToGist() {
    logger.debugSyncing("sync", () => "Running saveWorkspaceToGist(). CALLED BY: " + getCallerName("saveWorkspaceToGist"));
    if (!requireLogin()) {
        logger.info("sync: saveWorkspaceToGist", "Save skipped — need to login.");
        return;
    }

    if (isReadOnlyDevice()) {
        logger.info("sync: saveWorkspaceToGist", "Save skipped — read-only device.");
        return;
    }

    if (isSaving) {
        logger.info("sync: saveWorkspaceToGist", "Save skipped — already in progress.");
        return;
    }

    isSaving = true;

    try {
        const githubToken = getToken();
        let gistId = getGistId();

        showSyncState("saving");

        logger.debugSyncing("sync: saveWorkspaceToGist",
            `Starting save process. Current gistId: ${gistId || "(none)"}`
        );

        // --- 1. Build flat file list from workspace ---
        const workspace = getWorkspace();
        const files = flattenWorkspace(workspace);

        // 🚫 SAFETY GUARD: Prevent destructive overwrite
        if (!files || files.length === 0) {
            logger.warn(
                "sync: saveWorkspaceToGist",
                "Workspace is empty — refusing to sync to prevent destructive overwrite."
            );
            return;
        }

        const gistFiles = {};

        files.forEach(f => {
            gistFiles[f.path] = { content: f.content || "" };
        });

        // --- 2. Save metadata file ---
        const metadata = extractMetadata(workspace);
        setMetadata(metadata.nodes);

        gistFiles["__workspace.json"] = {
            content: JSON.stringify(metadata, null, 2)
        };

        logger.debugSyncing("sync: saveWorkspaceToGist",
            `Prepared ${Object.keys(gistFiles).length} files for saving: ${Object.keys(gistFiles).join(", ")}`
        );

        // --- 3. Prepare request body ---
        const body = {
            description: "BIAN Workspace Backup",
            public: false,
            files: gistFiles
        };

        let method = "POST";
        let url = GIST_API;

        // --- 4. Update existing gist ---
        if (gistId) {
            method = "PATCH";
            url = `${GIST_API}/${gistId}`;
            logger.debugSyncing("sync: saveWorkspaceToGist",
                `Updating existing gist with ID: ${gistId} using PATCH method.`
            );

            const existing = await githubFetch(`${GIST_API}/${gistId}`).then(r => r.json());

            if (existing && existing.files) {
                const existingNames = Object.keys(existing.files);
                logger.debugSyncing("sync: saveWorkspaceToGist",
                    `Existing cloud files before update: ${existingNames.join(", ")}`
                );

                for (const existingName of existingNames) {
                    if (existingName === "__workspace.json") continue;

                    const stillExistsLocally = files.some(f => f.path === existingName);
                    if (!stillExistsLocally) {
                        logger.debugSyncing("sync: saveWorkspaceToGist",
                            `Marking file for deletion: ${existingName}`
                        );
                        body.files[existingName] = null;
                    }
                }
            }
        } else {
            logger.debugSyncing("sync: saveWorkspaceToGist",
                "No gistId found — creating new gist via POST"
            );
        }

        logger.debugSyncing("sync: saveWorkspaceToGist", `Final request method: ${method}`);
        logger.debugSyncing("sync: saveWorkspaceToGist", `Final request URL: ${url}`);
        logger.debugSyncing("sync: saveWorkspaceToGist", `Final file list being sent: ${Object.keys(body.files).join(", ")}`);

        // --- 5. Send request ---
        const res = await githubFetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });


        const data = await res.json();

        if (!res.ok) {
            logger.error("sync: saveWorkspaceToGist",
                `Gist save error: ${data.message || "Unknown error"}`
            );
            showSyncState("error");
            showNotification("error", "Failed to save workspace");
            logger.info("sync: saveWorkspaceToGist", "--- SAVE FAILED ---");
            return;
        }

        // --- 6. Store gistId if new ---
        if (!gistId && data.id) {
            logger.debugSyncing("sync: saveWorkspaceToGist",
                `New gist created with ID: ${data.id}`
            );
            setGistId(data.id);
            gistId = data.id;
        }

        // --- 7. Compute new cloud hash using corrected loader ---     
        // After saving, compute hash from the local workspace we just pushed
        const newFlat = flattenWorkspace(getWorkspace());
        lastSyncedHash = await computeWorkspaceHash(newFlat);


        localStorage.setItem("lastSyncedHash", lastSyncedHash);
        lastSuccessfulSyncTime = Date.now();

        logger.debugSyncing("sync: saveWorkspaceToGist", "Save successful.");
        logger.debugSyncing("sync: saveWorkspaceToGist",
            `Updated lastSyncedHash: ${lastSyncedHash}`
        );
        logger.debugSyncing("sync: saveWorkspaceToGist", "--- SAVE END ---");

        showSyncState("synced");
        showNotification("success", "Saved to cloud");

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return false;
        }

        logger.error("sync: saveWorkspaceToGist", error);
        return false;
    } finally {
        isSaving = false;
    }
}

export function saveEmergencySnapshot(reason, extra = {}) {
    logger.debugSyncing("sync", () => "Running saveEmergencySnapshot(). CALLED BY: " + getCallerName("saveEmergencySnapshot"));
    exportWorkspace(reason, extra);
}

export function buildReadableWorkspaceExport(reason = "manual-export", extra = {}) {
    logger.debugSyncing("sync", () => "Running buildReadableWorkspaceExport(). CALLED BY: " + getCallerName("buildReadableWorkspaceExport"));
    const tree = getWorkspace();
    const flat = flattenWorkspace(tree);

    // --- METADATA (with fallback) ---
    let metadata = getMetadata();
    if (!metadata) {
        try {
            const raw = localStorage.getItem("__workspace_metadata");
            metadata = raw ? JSON.parse(raw) : { error: "metadata unavailable during emergency dump" };
        } catch (e) {
            metadata = { error: "metadata unavailable during emergency dump" };
        }
    }

    let output = "";

    // --- HEADER ---
    output += "===== WORKSPACE EXPORT =====\n";
    output += `Reason: ${reason}\n`;
    output += `Timestamp: ${new Date().toISOString()}\n`;
    output += `Device: ${deviceId}\n`;
    output += `Gist: ${getGistId() || "null"}\n`;
    output += `LastSyncedHash: ${lastSyncedHash || "null"}\n`;
    output += `SyncEnabled: ${syncEnabled}\n`;

    // Extra anomaly/debug context
    for (const [key, value] of Object.entries(extra)) {
        output += `${key}: ${JSON.stringify(value)}\n`;
    }

    output += "\n";

    // --- METADATA BLOCK ---
    output += "===== METADATA =====\n";
    output += JSON.stringify(metadata, null, 2) + "\n\n";

    // --- FOLDERS BLOCK ---
    output += "===== FOLDERS =====\n";

    // Extract folder paths from the tree
    const folderPaths = [];

    function walk(node, parentPath = "") {
        if (node.type === "folder") {
            const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
            folderPaths.push(folderPath);

            if (Array.isArray(node.children)) {
                for (const childId of node.children) {
                    const child = tree.find(n => n.id === childId);
                    if (child) walk(child, folderPath);
                }
            }
        }
    }

    // Walk all root-level nodes
    for (const node of tree) {
        if (node.type === "folder" && !node.parentId) {
            walk(node, "");
        }
    }

    // Output folder paths
    if (folderPaths.length === 0) {
        output += "(none)\n\n";
    } else {
        for (const folderPath of folderPaths) {
            output += folderPath + "\n";
        }
        output += "\n";
    }

    // --- FILES BLOCK ---
    for (const file of flat) {
        output += `===== FILE: ${file.path} =====\n`;
        output += file.content + "\n\n";
    }

    return output;
}

export function markLocalEdit() {
    lastLocalEditTime = Date.now();
    //logger.debugSyncing("sync: markLocalEdit", `Local edit detected at ${new Date(lastLocalEditTime).toISOString()}`);
}

export function showSyncState(state) {
    logger.debugSyncing("sync", () => "Running showSyncState(). CALLED BY: " + getCallerName("showSyncState"));

    const map = {
        saving:   ["saving",   "Saving…"],
        synced:   ["synced",   "Synced"],
        error:    ["error",    "Error"],
        readonly: ["readonly", "Read‑only"]
    };

    if (map[state]) {
        setSyncStatus(...map[state]);
    }
}


export async function loadWorkspaceFromGist() {
    logger.debugSyncing("sync", () => "Running loadWorkspaceFromGist. CALLED BY: " + getCallerName("loadWorkspaceFromGist"));
    logger.debugSyncing("sync", "loadWorkspaceFromGist gistId:", getGistId());

    if (!requireLogin()) {
        logger.info("sync: loadWorkspaceFromGist", "Login not required");
        return null;
    }

    const gistId = getGistId();
    const githubToken = getToken();

    if (!gistId) {
        showNotification("info", "No cloud backup found. Save to Cloud first.");
        logger.info("sync: loadWorkspaceFromGist", "No cloud backup found.");
        return null;
    }

    try {
        const res = await githubFetch(`${GIST_API}/${gistId}`);

        if (!res.ok) {
            logger.error("sync: loadWorkspaceFromGist", `GitHub returned ${res.status}`);
            return null;
        }

        const data = await res.json();
        const files = data.files || {};

        // ------------------------------------------------------------
        // 1. Parse metadata file
        // ------------------------------------------------------------
        let metadata = [];

        if (files["__workspace.json"]) {
            try {
                const parsed = JSON.parse(files["__workspace.json"].content);

                // NEW: extract nodes array
                if (Array.isArray(parsed.nodes)) {
                    metadata = parsed.nodes;
                } else {
                    metadata = [];
                }

            } catch (err) {
                logger.error("sync: loadWorkspaceFromGist", "Failed to parse metadata", err);
                metadata = [];
            }
        }


        if (!Array.isArray(metadata)) {
            metadata = [metadata];
        }
        setMetadata(metadata);

        logger.debugSyncing("sync: loadWorkspaceFromGist", "Parsed metadata:", metadata);

        // ------------------------------------------------------------
        // 2. Build flat list: FOLDERS FIRST
        // ------------------------------------------------------------
        const flat = [];

        for (const m of metadata) {
            logger.debugSyncing("sync: loadWorkspaceFromGist", "Push to flat if folder. m of metadata: ", m.id,m.type,m.path);
            if (m.type === "folder") {
                flat.push({
                    path: m.path,
                    content: null,
                    id: m.id,
                    isPublic: m.isPublic ?? false,
                    publicId: m.publicId ?? null,
                    publicAt: m.publicAt ?? null
                    //updatedAt: m.updatedAt ?? Date.now()
                });
                logger.debugSyncing("sync: loadWorkspaceFromGist", "Pushed to flat (folder): ", flat[flat.length - 1]);
            }
        }
        logger.debugSyncing("sync: loadWorkspaceFromGist", "Flat (folders): ", flat);

        // ------------------------------------------------------------
        // 3. Add file entries SECOND
        // ------------------------------------------------------------
        for (const filename in files) {
            if (filename === "__workspace.json") continue;

            flat.push({
                path: filename,
                content: files[filename].content || ""
            });
            logger.debugSyncing("sync: loadWorkspaceFromGist", "Pushed to flat (file): ", flat[flat.length - 1]);
        }

        // ------------------------------------------------------------
        // 4. Build metadata lookup map (decoded paths)
        // ------------------------------------------------------------
        const metaMap = new Map();

        for (const m of metadata) {
            if (!m || !m.path) continue;

            // m.path is already decoded, e.g. "_App___Bugs.md"
            metaMap.set(m.path, m);
        }



        logger.debugSyncing("sync: loadWorkspaceFromGist", "Metadata map keys:", Array.from(metaMap.keys()));


        // ------------------------------------------------------------
        // 5. Merge metadata into flat entries
        // ------------------------------------------------------------
        for (const entry of flat) {
            if (!entry || !entry.path) continue;

            // entry.path is encoded → decode it to match metadata paths
            const decodedFlatPath = decodeName(entry.path);

            const meta = metaMap.get(decodedFlatPath);

            if (meta) {
                logger.debugSyncing("sync: loadWorkspaceFromGist", "Merging metadata for:", decodedFlatPath, meta);
            } else {
                logger.warn("sync: loadWorkspaceFromGist", "No metadata found for:", decodedFlatPath);
            }

            entry.id        = meta?.id        ?? entry.id ?? null;
            entry.isPublic  = meta?.isPublic  ?? entry.isPublic ?? false;
            entry.publicId  = meta?.publicId  ?? entry.publicId ?? null;
            entry.publicAt  = meta?.publicAt  ?? entry.publicAt ?? null;
            //entry.updatedAt = meta?.updatedAt ?? entry.updatedAt ?? Date.now();
        }


        // ------------------------------------------------------------
        // 6. Final debug summary
        // ------------------------------------------------------------
        logger.debugSyncing("sync: loadWorkspaceFromGist", "Returning cloud data:", {
            flatType: Array.isArray(flat) ? "array" : typeof flat,
            flatLength: flat.length,
            metadataType: Array.isArray(metadata) ? "array" : typeof metadata,
            metadataLength: metadata.length,
            fileKeys: Object.keys(files)
        });

        return {
            flat,
            metadata
        };

        logger.debugSyncing("sync: loadWorkspaceFromGist", "loadWorkspaceFromGist() END");


    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            throw error; // <-- LET IT PROPAGATE TO THE SYNC ENGINE
        }

        logger.error("sync: loadWorkspaceFromGist", {
            message: error.message,
            stack: error.stack
        });

        return null; // only swallow NON-auth errors
    }

}


async function getNewestGistAcrossAccount() {
    logger.debugSyncing("sync", () => "Running getNewestGistAcrossAccount(). CALLED BY: " + getCallerName("getNewestGistAcrossAccount"));
    if (!requireLogin()) {
        logger.info("sync: getNewestGistAcrossAccount", "Login not required")
        return null;
    }

    try {
        const githubToken = getToken();

        const res = await githubFetch("https://api.github.com/gists");

        if (!res.ok) return null;

        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) return null;

        // Sort by updated_at descending
        list.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

        return list[0]; // newest gist

 
    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return false;
        }

        logger.error("sync: getNewestGistAcrossAccount", error);
        return null;
    }

}

export async function listGistRevisions() {
    logger.debugSyncing("sync", () => "Running listGistRevisions(). CALLED BY: " + getCallerName("listGistRevisions"));
    if (!requireLogin()) {
        logger.info("sync: listGistRevisions", "Login not required")
        return [];
    }

    try {
        const githubToken = getToken();
        const gistId = getGistId();

        if (!gistId) {
            showNotification("info", "No cloud backup found");
            return [];
        }

        const res = await githubFetch(`${GIST_API}/${gistId}/commits`);

        const data = await res.json();
        return data;

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return false;
        }

        logger.error("sync: listGistRevisions", error);
        return [];
    }

}

export async function restoreFromGistVersion(versionId) {
    logger.debugSyncing("sync", () => "Running restoreFromGistVersion(). CALLED BY: " + getCallerName("restoreFromGistVersion"));
    if (!requireLogin()) {
        logger.info("sync: restoreFromGistVersion", "Login not required")
        return;
    }

    if (isReadOnlyDevice() || !getSyncEnabled()) {
        logger.info("sync: restoreFromGistVersion", "Restore skipped — read-only device or sync disabled.");
        return;
    }

    try {
        const gistId = getGistId();
        const githubToken = getToken();

        const res = await githubFetch(`${GIST_API}/${gistId}/${versionId}`);

        const data = await res.json();

        // ⭐ 1. Load metadata file if present
        const metadataFile = data.files["__workspace.json"];
        let metadata = null;

        if (metadataFile && metadataFile.content) {
            try {
                metadata = JSON.parse(metadataFile.content);
            } catch (e) {
                console.warn("Invalid metadata file", e);
            }
        }

        // 2. Convert flat gist files → recursive workspace tree
        const flat = {};
        for (const filename in data.files) {
            if (filename === "__workspace.json") continue; // skip metadata file
            flat[filename] = data.files[filename].content;
        }

        // 1. Extract cloud flat files (excluding metadata)
        const cloudFlat = {};
        for (const filename in data.files) {
            if (filename !== "__workspace.json") {
                cloudFlat[filename] = data.files[filename].content;
            }
        }

        // 2. Parse cloud metadata
        const cloudMetadata = metadata || [];
        // ensure passing an array
        if (!Array.isArray(cloudMetadata)) {
            cloudMetadata = [cloudMetadata];
        }

        // 3. Load local workspace (unsaved work)
        const localTree = getWorkspace();

        // 4. Merge cloud + local using metadata to preserve IDs
        const merged = mergeWorkspace(localTree, cloudFlat, cloudMetadata);

        // 5. Save + render
        setWorkspace(merged);
        saveState();
        renderSidebar();


        showNotification("success", "Workspace restored from previous version");

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return false;
        }

        logger.error("sync: restoreFromGistVersion", error);
        return;
    }

}

export async function showRestoreDialog() {
    logger.debugSyncing("sync", () => "Running showRestoreDialog(). CALLED BY: " + getCallerName("showRestoreDialog"));
    const revisions = await listGistRevisions();
    if (!revisions || revisions.length === 0) {
        logger.info("sync: showRestoreDialog", "No Gist revisions found")
        return;
    }    

    try {
        let msg = "Choose a version to restore:\n\n";
        revisions.forEach((rev, i) => {
            msg += `${i + 1}. ${rev.version} — ${rev.committed_at}\n`;
        });

        const choice = prompt(msg);
        if (!choice) return;

        const index = parseInt(choice, 10) - 1;
        const versionId = revisions[index]?.version;
        if (!versionId) return;

        try {
            await restoreFromGistVersion(versionId);
        } catch (err) {
            if (err.message === "TOKEN_INVALID") {
                handleExpiredToken();
                return;
            }
            throw err;
        }                

    } catch (error) {
        logger.error("sync: showRestoreDialog", error);
        return;
    }      
}

async function adoptOrCreateGist() {
    logger.debugSyncing("sync", () => "Running adoptOrCreateGist(). CALLED BY: " + getCallerName("adoptOrCreateGist"));
    const token = getToken();
    if (!token) {
        logger.info("sync: adoptOrCreateGist", `Token was null - exiting`);
        return null
    };

    // --- 1. Try to adopt newest existing gist ---
    try {
        const newest = await getNewestGistAcrossAccount();

        if (newest && newest.id) {
            logger.info("sync: adoptOrCreateGist", `Adopting existing gist ${newest.id}`);
            setGistId(newest.id);
            return newest.id;
        }

        logger.info("sync: adoptOrCreateGist", "No existing gists found — will create new gist");
    } catch (err) {
        logger.error("sync: adoptOrCreateGist", "Failed while checking for existing gists", err);
        // We *continue* — failure to list gists should not block creation
    }

    // --- 2. Create a new gist ---
    try {
        const res = await githubFetch("https://api.github.com/gists", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                description: "Workspace",
                public: false,
                files: {
                    "workspace.json": {
                        content: JSON.stringify({ created: Date.now() }, null, 2)
                    }
                }
            })
        });

        if (!res.ok) {
            logger.error( "sync: adoptOrCreateGist", `GitHub returned ${res.status} when creating gist` );
            return null;
        }

        const data = await res.json();

        if (!data || !data.id) {
            logger.error("sync: adoptOrCreateGist", "GitHub response missing gist ID", data);
            return null;
        }

        logger.info("sync: adoptOrCreateGist", `Created new gist ${data.id}`);
        setGistId(data.id);
        return data.id;

    } catch (error) {
        if (error.message === "TOKEN_INVALID") {
            handleExpiredToken();
            return false;
        }
        logger.error("sync: adoptOrCreateGist", "Exception while creating gist", err);
        return null;
    }

}

export async function applyCloudWorkspace() {
    logger.debugSyncing("sync.applyCloudWorkspace", () => "START applyCloudWorkspace(). CALLED BY: " + getCallerName("applyCloudWorkspace"));

    // ------------------------------------------------------------
    // 1. Load cloud data
    // ------------------------------------------------------------
    const cloud = await loadWorkspaceFromGist();

    if (!cloud) {
        logger.warn("sync.applyCloudWorkspace", "Cloud returned null");
        return false;
    }

    if (!Array.isArray(cloud.flat) || cloud.flat.length === 0) {
        logger.warn("sync.applyCloudWorkspace", "Cloud flat list empty");
        return false;
    }

    logger.debugSyncing("sync.applyCloudWorkspace", "Cloud data loaded", {
        flatLength: cloud.flat.length,
        metadataLength: cloud.metadata?.length ?? 0
    });

    // ------------------------------------------------------------
    // 2. Inflate workspace
    // ------------------------------------------------------------
    logger.debugSyncing("sync.applyCloudWorkspace", "Inflating cloud workspace…");

    let workspace;
    try {
        workspace = inflateWorkspace(cloud.flat);
    } catch (err) {
        logger.error("sync.applyCloudWorkspace", "inflateWorkspace() threw", {
            message: err.message,
            stack: err.stack
        });
        return false;
    }

    if (!Array.isArray(workspace)) {
        logger.error("sync.applyCloudWorkspace", 
            "inflateWorkspace returned invalid workspace", 
            { type: typeof workspace }
        );
        return false;
    }

    logger.debugSyncing("sync.applyCloudWorkspace", "Inflation complete", {
        workspaceLength: workspace.length
    });

    // ------------------------------------------------------------
    // 3. Apply workspace
    // ------------------------------------------------------------
    logger.debugSyncing("sync.applyCloudWorkspace", "Applying workspace via setWorkspace()");
    setWorkspace(workspace);

    logger.debugSyncing("sync.applyCloudWorkspace", "Saving state");
    saveState();

    // ------------------------------------------------------------
    // 4. Render UI
    // ------------------------------------------------------------
    logger.debugSyncing("sync.applyCloudWorkspace", "Rendering sidebar");
    renderSidebar();

    if (activeFileId) {
        logger.debugSyncing("sync.applyCloudWorkspace", "Reloading active file:", activeFileId);
        loadFile(activeFileId);
    } else {
        logger.debugSyncing("sync.applyCloudWorkspace", "No active file to reload");
    }


    // ------------------------------------------------------------
    // 5. Final confirmation
    // ------------------------------------------------------------
    logger.info("sync.applyCloudWorkspace", "Cloud workspace applied successfully");

    return true;
}
