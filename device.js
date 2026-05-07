// device.js
// device.js
import { logger } from "./logger.js";

logger.debug("device", "device.js loaded from:", import.meta.url);

let deviceId = localStorage.getItem("deviceId");
logger.debug("device", "Loaded deviceId from localStorage:", String(deviceId));

if (!deviceId || deviceId === "undefined" || deviceId === "null" || deviceId.trim() === "") {
    deviceId = crypto.randomUUID();
    localStorage.setItem("deviceId", deviceId);
    logger.debug("device", "Generated NEW deviceId:", String(deviceId));
} else {
    logger.debug("device", "Using EXISTING deviceId:", String(deviceId));
}

export { deviceId };


