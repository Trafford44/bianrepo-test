import { handleOAuthRedirect, bindLoginButton, getToken, getGistId } from "./auth.js";
import { initResizers, renderSidebar, bindEditorEvents, bindPaneFocusEvents, updateLoginIndicator, loadFile, applyReadonlyUI } from "./ui.js";
import { loadState, migrateWorkspace, setWorkspace, getWorkspace, saveState, inflateWorkspace, createEmptyWorkspace } from "./workspace.js";
import { setupMarked } from "./md-editor.js";
import { startSyncLoop, bindVisibilityEvents, bindActivityEvents, reconcileLocalAndCloud, loadWorkspaceFromGist, getSyncEnabled, isReadOnlyDevice } from "./sync.js";
import { logger, isMobileLogDumpActive, dumpMobileLogs, purgeMobileLogs } from "./logger.js";
import { updateSyncToggleButton } from "./binding.js";

// Debug helpers (only used in DevTools)
window.debug = {
    loadState,
    saveState,
    getWorkspace,
    setWorkspace
};


/* it's critical that the order remains as below
This ensures:
The sync loop starts after login handling
The sync loop starts after the workspace is loaded
The sync loop starts before the user interacts with the UI
The sync loop starts before any file is opened
*/

logger.debug("app", "app.js loaded from:", import.meta.url);

export function hasOAuthCode() {
    const has = window.location.search.includes("code=");
    logger.debug("auth: init", `hasOAuthCode(): ${has}`, `URL: ${window.location.href}`);
    return has;
}

async function init() {
    logger.debug("app: init()", "Running init()");
    try {

        // determine early if we're on a read-only device and add a class, ready for later styling
        if (isReadOnlyDevice()) {
            applyReadonlyUI();
        }

        // mobile logging if turned on
        if (isMobileLogDumpActive()) {
            document.body.classList.add("mobile-debug-active");

            document.getElementById("dump-logs-btn").onclick = dumpMobileLogs;
            document.getElementById("purge-logs-btn").onclick = purgeMobileLogs;
        }

        // 1. Markdown renderer must be ready before any preview happens
        logger.debug("md-editor", "setupMarked()");
        setupMarked();

        // 2. Handle OAuth redirect ONLY if we actually have ?code=
        if (hasOAuthCode()) {
            logger.debug("auth", "Detected OAuth code, running handleOAuthRedirect()");
            await handleOAuthRedirect();
        }

        // ------------------------------------------------------------
        // 3. Load LOCAL workspace (but do NOT create or save anything)
        // ------------------------------------------------------------
        logger.debug("app: init()", "Running workspace.loadState()");
        let local = loadState();   // null or valid array
        let workspace = null;

        if (local && Array.isArray(local) && local.length > 0) {
            logger.debug("app: init()", "Using LOCAL workspace (non-empty)");
            workspace = local;
        } else {
            logger.debug("app: init()", "Local workspace missing or empty → trying CLOUD");

            // 3.1 Try to load CLOUD workspace
            // First inflate - Used to bootstrap the in-memory tree so the app can render UI and have something to work with.
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

            if (cloud && Array.isArray(cloud.flat) && cloud.flat.length > 0) {
                logger.debug("app: init()", "Cloud workspace FOUND → inflating");
                workspace = inflateWorkspace(cloud.flat);

                // SAFETY GUARD: ensure inflateWorkspace() returned a valid array
                if (!Array.isArray(workspace)) {
                    logger.error("app: init()", "inflateWorkspace returned invalid workspace, creating EMPTY workspace");
                    workspace = createEmptyWorkspace();
                }

            } else {
                logger.debug("app: init()", "No cloud workspace found → creating EMPTY workspace");
                workspace = createEmptyWorkspace();
            }


        }

        // ------------------------------------------------------------
        // 3.2 MIGRATE + SET WORKSPACE (this was missing before)
        // ------------------------------------------------------------
        logger.debug("app: init()", "Migrating workspace");
        const migrated = migrateWorkspace(workspace);

        logger.debug("app: init()", "Setting workspace into memory");
        setWorkspace(migrated);

        logger.debug("app: init()", "Saving workspace to localStorage");
        saveState(migrated);

        // ------------------------------------------------------------
        // 4. Now that workspace is loaded, reconcile safely
        // ------------------------------------------------------------
        logger.debug("app: init()", "Running sync.reconcileLocalAndCloud()");
        // Second inflate (from reconcileLocalAndCloud) - Used to validate and reconcile the local tree against cloud metadata.
        // This is the safety layer that prevents: drift, corruption, partial loads, stale local state, mismatched IDs, mismatched paths
        try {
            await reconcileLocalAndCloud(migrated);
        } catch (err) {
            if (err.message === "TOKEN_INVALID") {
                handleExpiredToken();
                return;
            }
            throw err;
        }


        // ------------------------------------------------------------
        // 4.5 Bind visibility + activity events
        // ------------------------------------------------------------
        logger.debug("app: init()", "Running sync.bindVisibilityEvents()");
        bindVisibilityEvents();
        logger.debug("app: init()", "Running sync.bindActivityEvents()");
        bindActivityEvents();

        // ------------------------------------------------------------
        // 5. Syncing
        // ------------------------------------------------------------
        // 1. Sync disabled? Stop here.
        if (!getSyncEnabled()) {
            logger.info("app: init()", "Sync disabled at startup — skipping sync loop");
            updateSyncToggleButton();
        } else {

            // 2. Workspace empty? Stop here.
            const current = getWorkspace();
            if (!current || current.length === 0) {
                logger.warn("app: init()", "Workspace empty — skipping sync loop");
            } else {

                // 3. Token + gistId required
                const token = getToken();
                const gistId = getGistId();

                if (token && gistId) {
                    logger.debug("app: init()", "Starting sync loop (token + gistId present)");
                    startSyncLoop();
                } else {
                    logger.debug("app: init()", "Not starting sync loop — missing token or gistId");
                }
            }
        }


        // ------------------------------------------------------------
        // 6. Render UI
        // ------------------------------------------------------------
        logger.debug("app: init()", "Running ui.renderSidebar()");
        renderSidebar();

        // 7. Bind login button AFTER sidebar is rendered
        logger.debug("app: init()", "Running auth.bindLoginButton()");
        bindLoginButton();

        // 8. Update login indicator AFTER login button exists
        logger.debug("app: init()", "Running ui.updateLoginIndicator()");
        updateLoginIndicator();

        // 9. Bind UI interactions
        logger.debug("app: init()", "Running ui.initResizers()");
        initResizers();
        logger.debug("app: init()", "Running ui.bindEditorEvents()");
        bindEditorEvents();
        logger.debug("app: init()", "Running ui.bindPaneFocusEvents()");
        bindPaneFocusEvents();

        // ------------------------------------------------------------
        // 10. Browser history: handle Back/Forward navigation
        // ------------------------------------------------------------
        logger.debug("app: init()", "Adding popState listener");
        window.addEventListener("popstate", (event) => {
            if (event.state && event.state.fileId) {
                logger.debug("app: popstate", "Navigating to fileId:", event.state.fileId);
                loadFile(event.state.fileId);
            } else {
                logger.debug("app: popstate", "event.state & event.state.fileId not found");
            }
        });

    } catch (err) {
        console.log("app: init()", "Unhandled error in init()", err);
    }
}


init();
