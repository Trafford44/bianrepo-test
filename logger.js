// logger.js

// mobile logging
const MOBILE_LOG_DUMP_ENABLED = true; // or false by default
const fullLog = [];

// all else
const LOG_LEVELS = {
  NONE: 0,
  WATCH: 1,  
  ERROR: 2, 
  WARN: 3,
  INFO: 4,
  DEBUG: 5
};

let LOG_ENTRY_COUNTER = 0;

// Change this per module if you want different log levels for different parts of the app
let CURRENT_LEVEL = LOG_LEVELS.INFO;

// needs to be a function, rathat than be stored in a const - somethign to do with how the module is imported and used in app.js.  If we try to determine "isMobile" at the top level, it doesn't work because of the way the module is loaded.  By making it a function, we can check at runtime when it's actually called.
function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.userAgent.includes("Mac") && "ontouchend" in document)
        || ("ontouchstart" in window && navigator.maxTouchPoints > 0);
}

export function isMobileLogDumpActive() {
    return MOBILE_LOG_DUMP_ENABLED && isMobile();
}

// use like:  logger.debug("PUML", pumlText, null, { multiline: true, lineNumbers: true });
function log(levelName, levelValue, source, message, details, options = {}) {
  if (CURRENT_LEVEL === LOG_LEVELS.NONE) return;
  if (levelValue > CURRENT_LEVEL) return;

  const timestamp = formatDateNZ();

  const colours = {
    INFO:  "color: #4da3ff",
    DEBUG: "color: #337e36",
    WARN:  "color: #e6a700",
    ERROR: "color: #ff4d4d",
    WATCH: "color: #ce13e7",
    DEBUGSYNCING: "color: #64e713" 
  };

  const style = colours[levelName] || "color: inherit";
  const header = `#${++LOG_ENTRY_COUNTER} [${timestamp}] [${levelName}] [${source}]`;

  // mobile logging
  const entry = details !== undefined
      ? `${header} ${message} ${JSON.stringify(details)}`
      : `${header} ${message}`;
  if (MOBILE_LOG_DUMP_ENABLED && isMobile()) {
      fullLog.push(entry);
  }


  // If multiline formatting is requested
  if (options.multiline) {
    const formatted = formatMultiline(message, {
      lineNumbers: options.lineNumbers
    });

    if (MOBILE_LOG_DUMP_ENABLED && isMobile()) {
        fullLog.push(`${header}\n${formatted}`);
    }

    printStyledBlock(header, formatted);
    return;
  }

  // Normal logging
  if (details !== undefined && details !== null) {
    console.log("%c" + header + " " + message, style, details);
  } else {
    console.log("%c" + header + " " + message, style);
  }
}

function formatMultiline(text, { lineNumbers = false } = {}) {
  if (!text || typeof text !== "string") return text;

  // Normalize newlines
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");

  if (lineNumbers) {
    return lines
      .map((line, i) => `${String(i + 1).padStart(3, " ")} | ${line}`)
      .join("\n");
  }

  return lines.join("\n");
}


function printStyledBlock(header, text) {
  // Combine into one string to ensure everything stays together
  console.log("DEBUG: printStyledBlock was called"); // Temporary check
  const output = `--- ${header} ---\n${text}`;

  console.log(
    `%c${output}`,
    `
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #333;
      background: #fdfdfd;
      display: block;
      white-space: pre;
      padding: 10px;
      border-left: 5px solid #ce13e7;
    `
  );
}


export const logger = {
  setLevel(level) {
    CURRENT_LEVEL = level;
  },

  error(source, message, details = null, options = {}) {
    log("ERROR", LOG_LEVELS.ERROR, source, message, details, options);
  },

  watch(source, message, details = null, options = {}) {
    log("WATCH", LOG_LEVELS.WATCH, source, message, details, options);
    // Trigger a browser alert for WATCH logs
    if (source === "createNewID" ) {
      alert(`New UUID generated: ${message}`);
    }
    if (source === "mergeWorkspace:id-missing" ) {
      alert(`Missing ID detected!: ${message}`);
    }        
  },

  warn(source, message, details = null, options = {}) {
    log("WARN", LOG_LEVELS.WARN, source, message, details, options);
  },

  info(source, message, details = null, options = {}) {
    log("INFO", LOG_LEVELS.INFO, source, message, details, options);
  },

  debug(source, message, details = null, options = {}) {
    // If DEBUG is disabled, exit immediately — no message(), no overhead
    if (LOG_LEVELS.DEBUG < this.currentLevel) return;

    // If message is a function, call it to get the actual message. This allows for lazy evaluation of debug messages.
    // will be passed getCallerName() to get caller name if debug is not enabled (old pattern was always calling this, regardless - big overhead)
    if (typeof message === "function") {
      message = message();
    }

    log("DEBUG", LOG_LEVELS.DEBUG, source, message, details, options);
  },

  // semantic highlight channel
  debugSyncing(source, message, details = null, options = {}) {
    // use to enable filtering of specific "Syncing" debug messages in the console. These are still logged at DEBUG level but have a special source tag.

    // If DEBUG is disabled, exit immediately — no message(), no overhead
    if (LOG_LEVELS.DEBUG < this.currentLevel) return;

    if (typeof message === "function") {
      message = message();
    }

    log("DEBUGSYNCING", LOG_LEVELS.DEBUG, `${source}-SYNCING`, message, details, options);
  }  

};

export { LOG_LEVELS };

export function formatDateNZ() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type).value;

  return `${get("year")}-${get("month")}-${get("day")} `
       + `${get("hour")}:${get("minute")}:${get("second")} NZ`;
}

 // testing - show teh stack
  //console.log("=== STACK DUMP ===\n" + new Error().stack);


export function getCallerName(currentFunctionName = null) {
  const stack = new Error().stack;
  if (!stack || !currentFunctionName) return "unknown";

  // testing - show the stack
  //console.log("=== STACK DUMP ===\n" + new Error().stack);  

  const lines = stack.split("\n").map(l => l.trim());
  lines.shift(); // remove "Error"

  const skip = [
    "getCallerName",
    "logger",
    "debug",
    "info",
    "warn",
    "error",
    "watch"
  ];

  let foundCurrent = false;
  let recursionDetected = false;
  let immediateSite = null;
  let rootNamed = null;

  for (const line of lines) {
    const match = line.match(/at (\S+)/);
    const fn = match ? match[1] : null;
    if (!fn) continue;

    // Skip logger/internal frames
    if (skip.some(s => fn.includes(s))) continue;

    // Skip call sites inside the same file as the current function
    // e.g. workspace.js:48:13 when currentFunctionName is sortTree
    if (fn.includes(".js:") && fn.includes(currentFunctionName) === false) {
      const file = fn.split(":")[0];
      if (file.includes("workspace.js")) continue;
    }

    // Step 1: find the current function
    if (!foundCurrent) {
      if (fn.includes(currentFunctionName)) {
        foundCurrent = true;
      }
      continue;
    }

    // Step 2: detect recursion
    if (fn.includes(currentFunctionName)) {
      recursionDetected = true;
      continue;
    }

    // Step 3: first non-recursive frame = immediate caller
    if (!immediateSite) {
      immediateSite = fn;
      continue;
    }

    // Step 4: first named function = root caller
    if (!rootNamed && !fn.includes(".js:") && !fn.includes("<anonymous>")) {
      rootNamed = fn;
      break;
    }
  }

  // Build output
  if (rootNamed) {
    if (recursionDetected) {
      return `${rootNamed} (recursive, via ${immediateSite ?? "unknown"})`;
    }
    return rootNamed;
  }

  return immediateSite ?? "unknown";
}

export function dumpMobileLogs() {
    const blob = new Blob([fullLog.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "mobile-debug-log.txt";
    a.click();

    URL.revokeObjectURL(url);
}

export function purgeMobileLogs() {
    fullLog.length = 0;
    LOG_ENTRY_COUNTER = 0;
    fullLog.push("[LOG PURGED] --- new session starting ---");
}

if (MOBILE_LOG_DUMP_ENABLED && isMobile()) {
    window.onerror = function(message, source, lineno, colno, error) {
        fullLog.push(`#${++LOG_ENTRY_COUNTER} [${formatDateNZ()}] [ERROR] [window.onerror] ${message} at ${source}:${lineno}:${colno}`);
    };

    window.onunhandledrejection = function(event) {
        fullLog.push(`#${++LOG_ENTRY_COUNTER} [${formatDateNZ()}] [ERROR] [unhandledrejection] ${event.reason}`);
    };
}

