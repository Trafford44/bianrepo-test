
/**
 * auth.js
 * ----------
 * Handles all GitHub authentication and token management for the app.
 *
 * This module is responsible for initiating the GitHub OAuth login flow,
 * receiving the redirect callback, extracting and storing the access token,
 * and exposing helpers that other modules use to verify authentication state.
 *
 * Responsibilities:
 * - Start the OAuth login process using the configured GitHub OAuth App.
 * - Handle the redirect callback and extract the temporary `code` parameter.
 * - Exchange the `code` for an access token via the Cloudflare Worker proxy.
 * - Store and retrieve the GitHub token in localStorage.
 * - Expose requireLogin() to guard actions that need authentication.
 * - Expose getToken(), clearToken(), getGistId(), setGistId() helpers.
 * - Update the UI login indicator via updateLoginIndicator() from ui.js.
 *
 * This module contains **no sync logic** and **no workspace logic**.
 * It focuses solely on authentication state and token lifecycle.
 *
 * Exported functions:
 * - beginLogin()          → Starts the OAuth login flow.
 * - handleOAuthRedirect() → Processes the redirect and stores the token.
 * - requireLogin()        → Ensures the user is authenticated before actions.
 * - getToken()            → Returns the stored GitHub token.
 * - clearToken()          → Logs the user out.
 * - getGistId() / setGistId() → Manage the active Gist reference.
 *
 * Dependencies:
 * - updateLoginIndicator() from ui.js for visual feedback.
 * - Cloudflare Worker endpoint for secure token exchange.
 *
 * The goal of this module is to keep authentication isolated, predictable,
 * and easy to maintain without mixing UI, sync, or editor concerns.
 */
import { updateLoginIndicator, showNotification } from "./ui.js";
import { runSyncCheck, stopSyncLoop } from "./sync.js";
import { deviceId } from "./device.js";
import { logger, getCallerName } from "./logger.js";

logger.debug("auth","auth.js loaded from:", import.meta.url);

const GITHUB_CLIENT_ID = "Ov23likIpQOhuNITyTEh";
const WORKER_URL = "https://round-rain-473a.richard-191.workers.dev";

export function getToken() {
    logger.debug("auth", () => "Running getToken(). CALLED BY: " + getCallerName("getToken"));
    try {
        logger.debug("auth", "getToken() reading key:", tokenKey());
        const t = localStorage.getItem(tokenKey());
        
        if (!t || t === "undefined" || t === "null") return null;
        return t;

    } catch (error) {
        logger.error("auth: getToken", error);
        return null;        
    }
}

export function clearToken() {
    logger.debug("auth", () => "Running clearToken(). CALLED BY: " + getCallerName("clearToken"));
    try {
        localStorage.removeItem(`github_token_${String(deviceId)}`);
        clearGistId();
        updateLoginIndicator();
        showNotification("info", "Signed out of Cloud");
        stopSyncLoop();
    } catch (error) {
        logger.error("auth: clearToken", error);
    }
}

export function clearGistId() {
    logger.debug("auth", "Running clearGistId()");
    try {
        localStorage.removeItem("gist_id");
        localStorage.removeItem(`gist_id_${String(deviceId)}`);
    } catch (error) {
        logger.error("auth: clearGistId", error);
    }
}

function tokenKey() {
    logger.debug("auth", () => "Running tokenKey(). CALLED BY: " + getCallerName("tokenKey"));
    return `github_token_${String(deviceId)}`;
}

export function getGistId() {
    logger.debug("auth", () => "Running getGistId(). CALLED BY: " + getCallerName("getGistId"));

    try {    
        // Preferred new key
        const scoped = localStorage.getItem("gist_id_" + String(deviceId));
        if (scoped && scoped !== "undefined" && scoped !== "null") {
            logger.debug("auth: getGistId", "Preferred new key found: ", scoped);
            return scoped;
        }

        // Legacy fallback
        const legacy = localStorage.getItem("gist_id");
        if (legacy && legacy !== "undefined" && legacy !== "null") {
            logger.debug("auth: getGistId", "Legacy fallback key found: ", legacy);
            return legacy;
        }
        logger.debug("auth: getGistId", "No key found");
        return null;

    } catch (error) {
        logger.error("auth: getGistId", "Failed to get gist id", { error });
        return null;
    }
}


export function setGistId(id) {
    logger.debug("auth", () => "Running setGistId(). CALLED BY: " + getCallerName("setGistId"), "ID:", id);

    try {
        // Preferred new key (device-scoped)
        localStorage.setItem("gist_id_" + String(deviceId), id);

        // Legacy key for backward compatibility
        localStorage.setItem("gist_id", id);

    } catch (error) {
        logger.error("auth: setGistId", "Failed to store gist id", { id, error });
        return;
    }
}


export function requireLogin() {
    logger.debug("auth", () => "Running requireLogin(). CALLED BY: " + getCallerName("requireLogin"));
    try {      
        const token = getToken();
        if (!token) {
            updateLoginIndicator();
            showNotification("warning", "Please sign in to Cloud first");
            return false;
        }
        return true;
    } catch (error) {
        logger.error("auth: requireLogin", error);
        return false;
    }          
}
// an alternative background sync logic that checks login state, without notifying teh user of outcome
export function isLoggedIn() {
    logger.debug("auth", () => "Running isLoggedIn(). CALLED BY: " + getCallerName("isLoggedIn"));
    return !!getToken();
}

export function bindLoginButton() {
    logger.debug("auth: bindLoginButton", () => "Running bindLoginButton(). CALLED BY: " + getCallerName("bindLoginButton"));
    const btn = document.getElementById("github-login");
    if (!btn) {
        logger.info("auth: bindLoginButton", "Login button not found");
        return;
    }

    logger.debug("Bind-time button:", btn);
    btn.addEventListener("click", (event) => {
        // 1. Check for ?redirect=... in the URL (dev override)
        const redirectOverride = new URLSearchParams(window.location.search).get("redirect");

        // 2. Use override if present, otherwise use the current page
        // comment out old
        // const redirectUri = redirectOverride ? redirectOverride : window.location.origin + window.location.pathname;
        const redirectUri = redirectOverride
            ? redirectOverride
            : window.location.origin + window.location.pathname;


        // 3. Build GitHub OAuth URL
        const url =
            `https://github.com/login/oauth/authorize` +
            `?client_id=${GITHUB_CLIENT_ID}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=gist`;

        // 4. Redirect to GitHub
        logger.debug("auth: bindLoginButton", "OAuth URL:", url);
        window.location.href = url;
        logger.debug("Click-time button:", event.target);

    });
    
}


export async function handleOAuthRedirect() {
    logger.debug("auth", () => "Running handleOAuthRedirect(). CALLED BY: " + getCallerName("handleOAuthRedirect"));
    try {      
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        window.history.replaceState({}, "", window.location.pathname);  // clean URL immediately
        if (!code) {
            logger.info("auth: handleOAuthRedirect", "No code found in URL Params");
            return;
        }
        const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
        });
        if (!res.ok) {
            logger.error("auth: handleOAuthRedirect", "OAuth worker failed", res.status);
            return;
        }

        const data = await res.json();

        if (data.access_token) {
            logger.debug("auth: handleOAuthRedirect", "Saving token under key:", "github_token_" + String(deviceId));
            localStorage.setItem("github_token_" + String(deviceId), data.access_token);
            logger.debug("auth: handleOAuthRedirect", "After save, reading back token:", localStorage.getItem(tokenKey()));
            logger.info("auth: handleOAuthRedirect", "GitHub login successful");
            updateLoginIndicator();
            await runSyncCheck("login");

        } else {
            logger.error("auth: handleOAuthRedirect", "OAuth response missing token", data);
        }
    } catch (error) {
        logger.error("auth: handleOAuthRedirect", error);
        return;
    }    

}

