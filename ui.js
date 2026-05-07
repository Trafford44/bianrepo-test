import { getToken, getGistId} from "./auth.js";
import { bindSmartKeyboardEvents, bindGlobalShortcuts, bindScrollSync, bindToolbarEvents, bindPopupEvents, bindSidebarEvents} from "./binding.js";
import { getWorkspace, setWorkspace, findNodeById, findNodeAndParent, createFolder, createFile, saveState, flattenWorkspace, logIdAnomaly, sortTree } from "./workspace.js";
import { getMetadata } from "./workspace-metadata.js";
import { logger, getCallerName } from "./logger.js";
import { EXCLUSION_FILES, buildReadableWorkspaceExport, lastSyncedHash, getSyncEnabled, isReadOnlyDevice, showSyncState } from "./sync.js";
import { deviceId } from "./device.js";

let saveTimer = null;
export let activeFileId = null;
let notificationTimeout = null;
let countdownInterval = null;
const contextMenu = document.getElementById("context-menu");
const contextMenuList = contextMenu.querySelector("ul");
let currentContextTarget = null;
const USE_KROKI = false;

logger.debug("ui","ui.js loaded from:", import.meta.url);

function isReadOnly() {
    return typeof isReadOnlyDevice === "function" && isReadOnlyDevice();
}


export function showContextMenu(target, items, x, y) {
    currentContextTarget = target;

    contextMenuList.innerHTML = "";

    items.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item.label;
        li.addEventListener("click", () => {
            item.action(target);
            hideContextMenu();
        });
        contextMenuList.appendChild(li);
    });

    // Make menu visible *before* measuring height
    contextMenu.classList.remove("hidden");

    // Measure menu height
    const menuHeight = contextMenu.offsetHeight;
    const viewportHeight = document.documentElement.clientHeight;

    // Default: open downward
    let top = y;

    // If menu would overflow → open upward
    if (y + menuHeight > viewportHeight) {
        top = y - menuHeight;
    }

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${top}px`;
}


export function hideContextMenu() {
    contextMenu.classList.add("hidden");
    currentContextTarget = null;
}

document.addEventListener("click", e => {
    if (!contextMenu.contains(e.target)) {
        hideContextMenu();
    }
});


async function renderPuml(resolvedPuml) {
    if (USE_KROKI) {
        // --- Kroki POST mode (inline SVG) ---
        try {
            const svg = await renderPumlViaKroki(resolvedPuml);

            if (!svg || !svg.trim()) {
                throw new Error("Kroki returned empty SVG output.");
            }

            if (!svg.trim().startsWith("<svg")) {
                throw new Error("Kroki returned non-SVG output:\n" + svg);
            }

            // IMPORTANT: return SVG with NO indentation
            return svg.trim();

        } catch (err) {
            throw new Error("Kroki render failed: " + err.message);
        }

    } else {
        // --- PlantUML URL mode (IMG + link) ---
        try {
            const url = getPumlRenderUrl(resolvedPuml);

            // IMPORTANT: NO leading spaces, NO indentation - ***********   DON'T INDENT - IT"LL BREAK THE DIAGRAM RENDERING!!!!!!!!   *************
            return `
<img src="${url}" alt="PlantUML Diagram">
<a href="${url}" target="_blank"
   style="font-size: 0.75rem; color: #9ca3af; margin-top: 1rem; text-decoration: underline;">
   Open SVG link
</a>
`.trim();

        } catch (err) {
            throw new Error("PlantUML URL render failed: " + err.message);
        }
    }
}



export function initResizers() {
    logger.debug("ui", () => "Running initResizers(). CALLED BY: " + getCallerName("initResizers"));
    const sbResizer = document.getElementById("sidebar-resizer");
    const sidebar = document.getElementById("sidebar");
    const edResizer = document.getElementById("editor-resizer");
    const editorCont = document.getElementById("editor-container");
    const workspace = document.getElementById("workspace-grid");

    // --- Helpers: normalize mouse/touch ---
    const getClientX = e => (e.touches ? e.touches[0].clientX : e.clientX);
    const getClientY = e => (e.touches ? e.touches[0].clientY : e.clientY);

    // ============================================================
    // SIDEBAR RESIZER (always horizontal drag)
    // ============================================================
    if (sbResizer) {
        const startSidebarResize = e => {
            e.preventDefault();
            sbResizer.classList.add("resizing");

            const handleMove = e2 => {
                const newWidth = getClientX(e2);
                if (newWidth >= 200 && newWidth <= 600) {
                    sidebar.style.width = newWidth + "px";
                }
            };

            const stop = () => {
                sbResizer.classList.remove("resizing");
                document.removeEventListener("mousemove", handleMove);
                document.removeEventListener("mouseup", stop);
                document.removeEventListener("touchmove", handleMove);
                document.removeEventListener("touchend", stop);
            };

            document.addEventListener("mousemove", handleMove);
            document.addEventListener("mouseup", stop);
            document.addEventListener("touchmove", handleMove, { passive: false });
            document.addEventListener("touchend", stop);
        };

        sbResizer.addEventListener("mousedown", startSidebarResize);
        sbResizer.addEventListener("touchstart", startSidebarResize, { passive: false });
    }

    // ============================================================
    // EDITOR RESIZER (horizontal in landscape, vertical in portrait)
    // ============================================================
    if (edResizer) {
        const startEditorResize = e => {
            e.preventDefault();
            edResizer.classList.add("resizing");

            const isPortrait = window.matchMedia("(orientation: portrait)").matches;
            const workspaceRect = workspace.getBoundingClientRect();

            // Capture starting values to prevent jumps
            const startX = getClientX(e);
            const startY = getClientY(e);
            const startWidth = editorCont.getBoundingClientRect().width;
            const startHeight = editorCont.getBoundingClientRect().height;

            const handleMove = e2 => {
                if (isPortrait) {
                    // ---------------------------
                    // PORTRAIT MODE → vertical drag (smooth, no jump)
                    // ---------------------------
                    const clientY = getClientY(e2);
                    const deltaY = clientY - startY;
                    const newHeight = startHeight - deltaY;

                    if (newHeight >= 100 && newHeight <= workspaceRect.height - 100) {
                        editorCont.style.height = newHeight + "px";
                        editorCont.style.flex = "none";
                    }

                } else {
                    // ---------------------------
                    // LANDSCAPE MODE → horizontal drag (unchanged)
                    // ---------------------------
                    const clientX = getClientX(e2);
                    const deltaX = clientX - startX;
                    const newWidth = startWidth - deltaX;

                    if (newWidth >= 100 && newWidth <= workspaceRect.width - 100) {
                        editorCont.style.width = newWidth + "px";
                        editorCont.style.flex = "none";
                    }
                }
            };

            const stop = () => {
                edResizer.classList.remove("resizing");
                document.removeEventListener("mousemove", handleMove);
                document.removeEventListener("mouseup", stop);
                document.removeEventListener("touchmove", handleMove);
                document.removeEventListener("touchend", stop);
            };

            document.addEventListener("mousemove", handleMove);
            document.addEventListener("mouseup", stop);
            document.addEventListener("touchmove", handleMove, { passive: false });
            document.addEventListener("touchend", stop);
        };

        edResizer.addEventListener("mousedown", startEditorResize);
        edResizer.addEventListener("touchstart", startEditorResize, { passive: false });
    }
}

function isExclusionFile(node) {
    //return node.type === "file" && EXCLUSION_FILES.has(node.name);
    return EXCLUSION_FILES.has(node.name);

    /*
    When we have paths populated, chane to using paths, so as to avoind duplicate files
    function isExcluded(node) {
        return EXCLUSION_PATHS.has(node.path);
    }
    */
}

// After: let tree = getWorkspace();
// use this for testing purposes - output nanmes of files & folders
function logNodes(nodes, depth = 0) {
    console.log("=== WORKSPACE TREE ===");
    nodes.forEach(node => {
        const indent = "  ".repeat(depth);

        if (node.type === "file") {
            console.log(`${indent}FILE: name="${node.name}", path="${node.path}", id=${node.id}`);
        } else if (node.type === "folder") {
            console.log(`${indent}FOLDER: name="${node.name}", path="${node.path}", id=${node.id}`);
            if (Array.isArray(node.children)) {
                logNodes(node.children, depth + 1);
            }
        } else {
            console.log(`${indent}UNKNOWN NODE TYPE`, node);
        }
    });
}

export function renderSidebar() {
    logger.debug("ui", () => "Running renderSidebar(). CALLED BY: " + getCallerName("renderSidebar"));
    const container = document.getElementById("sidebar-list");
    if (!container) return;

    let tree = getWorkspace();
    logger.debug("ui.renderSidebar()", "renderSidebar workspace root snapshot:", JSON.stringify(tree, null, 2));
    sortTree(tree);

    // testing purposes
    // logNodes(tree);

    // Filter out exclusion files
    tree = tree.filter(node => !isExclusionFile(node));

    container.innerHTML = "";

    if (!tree || tree.length === 0) {
        container.innerHTML = `<div class="empty-sidebar">No folders yet</div>`;
        return;
    }

    tree.forEach(node => {
        logger.debug("ui", "renderSidebar node", {
            name: node.name,
            id: node.id
        });

        const el = renderNode(node, 0);
        container.appendChild(el);
    });

    logger.debug(
        "ui.renderSidebar()",
        "FINAL SIDEBAR DOM:",
        container.cloneNode(true).outerHTML
    );

}

function renderNode(node, depth) {
    return node.type === "folder"
        ? renderFolderNode(node, depth)
        : renderFileNode(node, depth);
}


function renderFolderNode(folder, depth) {
    const wrapper = document.createElement("div");
    wrapper.className = "sidebar-folder";

    const readonly = isReadOnly();
    const isOpen = folder.isOpen ?? true;

    const header = document.createElement("div");
    header.className = "sidebar-folder-header";
    header.style.paddingLeft = `${depth === 0 ? 10 : depth * 16}px`;

    header.innerHTML = `
        <span class="folder-toggle">
            <span class="chevron ${isOpen ? "open" : ""}">▶</span>
        </span>
        <span class="folder-name">${folder.name.replace(/^_+/, "")}</span>
        <span class="folder-actions">
            ${readonly ? "" : `<button class="item-menu-btn" title="Actions">⋯</button>`}
        </span>
    `;

    const folderMenuItems = [
        { label: "Add File", action: () => addFile(folder.id) },
        { label: "Add Folder", action: () => createSubfolder(folder.id) },
        { label: "Rename", action: () => renameFolder(folder.id) },
        { label: "Delete", action: () => deleteFolder(folder.id) }
    ];

    if (!readonly) {
        // NORMAL MODE: context menu button
        const btn = header.querySelector(".item-menu-btn");
        if (btn) {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                showContextMenu(folder, folderMenuItems, e.pageX, e.pageY);
            });
        }

        // NORMAL MODE: right-click opens context menu
        header.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(folder, folderMenuItems, e.pageX, e.pageY);
        });

    } else {
        // READ-ONLY MODE: block right-click entirely
        header.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
        });
    }

    // Expand/collapse always allowed
    header.querySelector(".folder-toggle").addEventListener("click", e => {
        e.stopPropagation();

        const newState = !(folder.isOpen ?? true);
        folder.isOpen = newState;

        saveState();
        renderSidebar();
    });

    wrapper.appendChild(header);

    if (isOpen && folder.children.length > 0) {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "sidebar-folder-children";

        folder.children.forEach(child => {
            childrenContainer.appendChild(renderNode(child, depth + 1));
        });

        wrapper.appendChild(childrenContainer);
    }

    return wrapper;
}





function renderFileNode(file, depth) {
    const el = document.createElement("div");
    el.className = `file-item sidebar-file ${file.id === activeFileId ? "active" : ""}`;
    el.style.paddingLeft = `${depth * 16}px`;

    const readonly = isReadOnly();

    el.innerHTML = `
        <div class="file-main" style="display: flex; align-items: center; overflow: hidden; flex: 1;">
            <span class="file-icon">${file.name.endsWith(".md") ? "M↓" : "⧉"}</span>
            <span class="file-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${file.name}
            </span>
        </div>
        <div class="file-actions">
            ${readonly ? "" : `<button class="item-menu-btn" title="Actions">⋯</button>`}
        </div>
    `;

    // Load file + mobile auto-close
    el.addEventListener("click", e => {
        e.stopPropagation();
        loadFile(file.id);

        if (window.innerWidth < 1400 && window.matchMedia("(orientation: portrait)").matches) {
            document.body.classList.remove("sidebar-open");
        }
    });

    if (!readonly) {
        // NORMAL MODE: enable context menu button
        const btn = el.querySelector(".item-menu-btn");
        if (btn) {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                showContextMenu(file, [
                    { label: "Rename", action: () => renameFile(file.id) },
                    { label: "Duplicate", action: () => duplicateFile(file.id) },
                    { label: "Copy internal link", action: () => copyInternalLink(file.id) },
                    { label: "Delete", action: () => deleteFile(file.id) },
                    { label: "Export file", action: () => exportFile(file.id) }
                ], e.pageX, e.pageY);
            });
        }

        // NORMAL MODE: right-click opens context menu
        el.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(file, [
                { label: "Rename", action: () => renameFile(file.id) },
                { label: "Duplicate", action: () => duplicateFile(file.id) },
                { label: "Copy internal link", action: () => copyInternalLink(file.id) },
                { label: "Delete", action: () => deleteFile(file.id) },
                { label: "Export file", action: () => exportFile(file.id) }
            ], e.pageX, e.pageY);
        });

    } else {
        // READ-ONLY MODE: block right-click entirely
        el.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
        });
    }

    return el;
}


export function getInternalLink(fileId) {
    return `app://file/${fileId}`;
}

export function copyInternalLink(fileId) {
    const link = getInternalLink(fileId);

    navigator.clipboard.writeText(link)
        .then(() => {
            showNotification("success", "Internal link copied");
        })
        .catch(err => {
            console.error("Clipboard error:", err);
            showNotification("error", "Failed to copy link");
        });
}


export function duplicateFile(fileId) {
    logger.debug("ui", () => "Running duplicateFile(). CALLED BY: " + getCallerName("duplicateFile"));

    if (isReadOnlyDevice()) {
        showNotification("info", "Duplicate not allowed on read-only device");
        return;
    }  

    const tree = getWorkspace();
    const result = findNodeAndParent(tree, fileId);

    if (!result || result.node.type !== "file") {
        logger.info("UI: duplicateFile", "File node not found", fileId);
        return;
    }
    try {    
        const { node: file, parent } = result;

        logger.debug("ui: duplicateFile", "Original file node:", JSON.stringify(file, null, 2));

        // Generate a unique name like "MyFile.md copy", "MyFile.md copy 2", etc.
        const newName = generateCopyName(file.name, parent.children);

        const copy = createFile(newName, file.content);
        
        logger.debug("ui: duplicateFile", "Original file name: ", file.name, "Content length: ", file.content?.length, "Raw: ", file.content); 

        parent.children.push(copy);

        setWorkspace(tree);
        saveState();
        renderSidebar();
        loadFile(copy.id);

        showNotification("success", "File duplicated");
    } catch (error) {
        logger.error("ui: duplicateFile", error);
        return false;
    }           
}

function generateCopyName(name, siblings) {
    const extIndex = name.lastIndexOf(".");
    const base = extIndex !== -1 ? name.slice(0, extIndex) : name;
    const ext = extIndex !== -1 ? name.slice(extIndex) : "";

    let n = 1;
    let candidate = `${base} copy${ext}`;

    while (siblings.some(f => f.name === candidate)) {
        n++;
        candidate = `${base} copy ${n}${ext}`;
    }

    return candidate;
}


export function createFileInFolder(parentFolder) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Creating file not allowed on read-only device");
        return;
    }  
        
    const name = prompt("New file name:");
    if (!name || !name.trim()) return;

    const fileName = name.trim().endsWith(".md")
        ? name.trim()
        : name.trim() + ".md";

    parentFolder.children.push(createFile(fileName, ""));

    commitWorkspace();
}


export function createSubfolder(parentId) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Creating folder not allowed on read-only device");
        return;
    }
        
    const name = prompt("New Folder Name:");
    if (!name || !name.trim()) return;

    const tree = getWorkspace();
    const parent = findNodeById(tree, parentId);

    if (!parent || parent.type !== "folder") return;

    parent.children.push(createFolder(name.trim()));

    parent.children.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "folderenderFileNoder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    setWorkspace(tree);
    saveState();
    renderSidebar();
}


export function loadFile(fileId) {
    logger.debug("ui", () => "Running loadFile(). CALLED BY: " + getCallerName("loadFile"));
    const tree = getWorkspace();

    logger.debug("ui", "loadFile searching for id:", fileId);
    logger.debug("ui", "current workspace tree:", JSON.stringify(getWorkspace(), null, 2));
   
    const file = findNodeById(tree, fileId);

    if (!file || file.type !== "file") {
        console.warn("loadFile: file not found", fileId);
        return;
    }

    // set module variable
    activeFileId = file.id;

    document.getElementById("empty-state").classList.add("hidden");
    document.getElementById("workspace-grid").classList.remove("hidden");

    const textarea = document.getElementById("editor-textarea");
    textarea.value = file.content;

    document.getElementById("active-file-title").textContent = file.name;
    document.getElementById("active-file-type-icon").innerHTML =
        file.name.endsWith(".md")
            ? '<span class="type-label-md">MD</span>'
            : '<span class="type-label-puml">PUML</span>';

    if (file.name.endsWith(".md")) {
        if (!isReadOnlyDevice()) {
            document.getElementById("md-toolbar").classList.remove("hidden");
        }
    } else {
        document.getElementById("md-toolbar").classList.add("hidden");
    }

    updateToolbarVisibility();
    updatePreview();
    updateToolbar();
    renderSidebar();

    const preview = document.getElementById("preview-pane");
    preview.focus();

}

export function updateToolbarVisibility() {
    logger.debug("ui", () => "Running updateToolbarVisibility(). CALLED BY: " + getCallerName("updateToolbarVisibility"));

    // this function applies to the toolbar buttons only, not the sidebar buttons.  The sidebar buttons are currently in applyReadonlyUI
    const fileLoaded = !!activeFileId;
    const loggedIn = !!getToken() && !!getGistId();

    // Group A: Always visible
    const alwaysVisible = [
        "github-login",
        "save-btn",
        "load-btn",
        "restore-btn",
        "exportAll-btn",
        "importAll-btn",
        "sync-toggle-btn",
        "logout-btn"
    ];

    alwaysVisible.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "inline-flex";
    });

    // Group B: Visible only when a file is loaded
    const fileButtons = [
        "toggle-editor",
        "zoom-editor-in",
        "zoom-editor-out",
        "zoom-reset-btn",
        "copy-rendered-puml-btn",
        "delete-btn",        
        "puml-external-link"
    ];

    fileButtons.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = fileLoaded ? "inline-flex" : "none";
    });

    // Group C: Test button always hidden
    const testBtn = document.getElementById("test-btn");
    if (testBtn) testBtn.style.display = "none";

    // PUML button handled separately by updateToolbar()

    //make sure to disable write buttons if we're on a read-only device, regardless of file loaded or login state
    if (isReadOnlyDevice()) {
        // Hide all write buttons
        [
            "save-btn",
            "delete-btn",
            "restore-btn",
            "importAll-btn",
            "copy-rendered-puml-btn",
            "sync-toggle-btn"
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
    }
}

export function applyReadonlyUI() {
    // Global styling hook
    document.body.classList.add("readonly-mode");

    // Hide the editor immediately
    hideEditor();
    showSyncState("readonly");

    // Disable the toggle button - disable this for now
    /* const btn = document.getElementById("toggle-editor");
    btn.disabled = true;
    btn.textContent = "Editor Hidden (Read‑only)"; */

    // Hide sidebar write buttons
    const addFolder = document.getElementById("add-folder-btn");
    if (addFolder) addFolder.style.display = "none"; 
    
    // Hide and disable the editor
    const textarea = document.getElementById("editor-textarea");
    if (textarea) {
        textarea.readOnly = true;
        //use both the readOnly property and the readonly attribute for maximum compatibility with different browsers and assistive technologies
        textarea.setAttribute("readonly", "readonly");
        textarea.classList.add("readonly-editor");

        textarea.addEventListener("paste", e => {
            if (isReadOnlyDevice()) e.preventDefault();
        });

        textarea.addEventListener("drop", e => {
            if (isReadOnlyDevice()) e.preventDefault();
        });

    }    

}


function commitWorkspace() {
    logger.debug("ui", () => "Running commitWorkspace(). CALLED BY: " + getCallerName("commitWorkspace"));
    saveState();
    renderSidebar();
}

export function updateToolbar() {
    logger.debug("ui", () => "Running updateToolbar(). CALLED BY: " + getCallerName("updateToolbar"));
    const tree = getWorkspace();
    const file = findNodeById(tree, activeFileId);

    const pumlButtons = document.querySelectorAll(".puml-only");
    const show = file && file.name.endsWith(".puml");

    pumlButtons.forEach(btn => {
        logger.debug("ui.updateToolbar", "Setting button visibility to.  Button name: ", btn.classList);
        btn.style.display = show ? "inline-flex" : "none";
    });
}


export function renameFolder(folderId) {
    const tree = getWorkspace();
    const folder = findNodeById(tree, folderId);

    if (!folder || folder.type !== "folder") return;

    const newName = prompt("Rename folder:", folder.name);
    if (!newName || !newName.trim()) return;

    folder.name = newName.trim();

    setWorkspace(tree);
    saveState();
    renderSidebar();
}

export function deleteFolder(folderId) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Delete not allowed on read-only device");
        return;
    } 

    const tree = getWorkspace();
    const result = findNodeAndParent(tree, folderId);

    if (!result || result.node.type !== "folder") return;

    const { node, parent } = result;

    if (!confirm(`Delete folder "${node.name}" and all its contents?`)) return;

    if (parent) {
        parent.children = parent.children.filter(c => c.id !== folderId);
    } else {
        // deleting a top-level folder
        const newTree = tree.filter(c => c.id !== folderId);
        setWorkspace(newTree);
    }

    if (activeFileId && findNodeById(tree, activeFileId) === null) {
        activeFileId = null;
        document.getElementById("workspace-grid").classList.add("hidden");
        document.getElementById("empty-state").classList.remove("hidden");
    }

    updateToolbarVisibility();
    saveState();
    renderSidebar();
}


export async function updatePreview() {
    logger.debug("ui", () => "Running updatePreview(). CALLED BY: " + getCallerName("updatePreview"));

    const tree = getWorkspace();
    const file = findNodeById(tree, activeFileId);

    logger.debug(
        "ui: updatePreview",
        `ACTIVE FILE: ${activeFileId || "null"} NAME: ${file?.name || "null"}`
    );

    try {
        const textarea = document.getElementById("editor-textarea");
        const preview = document.getElementById("preview-pane");
        const link = document.getElementById("puml-external-link");
        const content = textarea.value;

        if (!file || file.type !== "file") {
            logger.warn("ui: updatePreview", "Active file not found or not a file");
            return;
        }

        // ------------------------------------------------------------
        //  SAVE CONTENT (DEBOUNCED)
        // ------------------------------------------------------------
        file.content = content;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveState(), 300);

        // ------------------------------------------------------------
        //  PUML FILE PREVIEW (.puml files)
        // ------------------------------------------------------------
        if (file.name.endsWith(".puml")) {
            logger.debug("ui: updatePreview", "Rendering PUML file:", file.name);

            // 0. CLEAR PREVIEW IMMEDIATELY so stale diagrams never remain
            preview.innerHTML = `
                <div style="color:#9ca3af; font-size:0.9rem; padding:1rem;">
                    Rendering diagram…
                </div>
            `;

            // 0. Resolve !include name:... inside the PUML file
            const withNames = resolvePumlIncludeNames(content, tree);
            // 1. Resolve !include app://file/... inside the PUML file
            const resolved = resolvePumlIncludes(withNames, tree);

            // output resolved to console for debugging
            // turn off - not required now that we have this in local storage
            //logger.watch("ui: updatePreview", "Resolved PUML content:\n" + resolved, null, { multiline: true, lineNumbers: true });

            if (!resolved.trim()) {
                logger.warn("ui: updatePreview", "Resolved PUML is empty");
                preview.innerHTML = `<pre style="color:red;">Resolved PUML is empty.</pre>`;
                return;
            }

            // 2. Encode PUML → PlantUML server URL (still used for external link)
            let url = "";
            try {
                url = getPumlRenderUrl(resolved);
            } catch (e) {
                logger.error("ui: updatePreview", "PUML encoding failed:", e);
                preview.innerHTML = `<pre style="color:red;">PUML encoding error:\n${e}\n\n${resolved}</pre>`;
                return;
            }

            logger.debug("ui: updatePreview", "PUML render URL:", url);

            // 3. Render the diagram (Kroki/PlantUML)
            let rendered;
            try {
                rendered = await renderPuml(resolved);
            } catch (e) {
                logger.error("ui: updatePreview", "PUML render failed:", e);
                preview.innerHTML = `
                    <div style="
                        padding:1rem;
                        color:#ef4444;
                        background:#2b2b2b;
                        border-left:4px solid #ef4444;
                        font-size:0.9rem;
                        white-space:pre-wrap;
                    ">
                        <strong>PUML render error</strong>
                        <div style="margin-top:0.5rem; color:#fca5a5;">
                            ${e.message}
                        </div>
                    </div>
                `;
                return;
            }

            // 4. Replace preview with the new diagram
            preview.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center;">
                    ${rendered}
                </div>
            `;

            // 5. External link (for "open in browser")
            try {
                link.href = getPumlHref(resolved);
            } catch (e) {
                logger.error("ui: updatePreview", "Failed to generate external PUML href:", e);
            }

            return;
        }


        // ------------------------------------------------------------
        //  MARKDOWN PREVIEW (INLINE @startuml BLOCKS)
        // ------------------------------------------------------------
        logger.debug("ui: updatePreview", "Rendering Markdown file:", file.name);

        // Matches any fenced code block: ``` ... ```
        // We treat everything inside as literal code and must NOT touch it.
        const fenceRegex = /```[\s\S]*?```/g;

        // ------------------------------------------------------------
        //  STEP 1: EXTRACT FENCED CODE BLOCKS
        //
        // We replace each ```...``` block with a placeholder so that:
        // - inline PUML detection does NOT see @startuml inside code fences
        // - includes are NOT resolved inside code fences
        // - the user can show PUML syntax as code without rendering it
        // ------------------------------------------------------------
        const fencedBlocks = [];
        let fencedIndex = 0;

        const contentWithPlaceholders = content.replace(fenceRegex, (match) => {
            const placeholder = `@@FENCE_${fencedIndex}@@`;
            fencedBlocks.push(match);   // store the full fenced block
            fencedIndex += 1;
            return placeholder;         // replace it with a marker
        });

        // ------------------------------------------------------------
        //  STEP 2: PROCESS INLINE PUML ONLY IN NON-FENCED TEXT
        //
        // At this point, all ```...``` blocks have been replaced by placeholders,
        // so pumlRegex will only see @startuml blocks that are truly "inline"
        // in the Markdown, not inside code fences.
        // ------------------------------------------------------------
        // ------------------------------------------------------------
        //  STEP 2: PROCESS INLINE PUML ONLY IN NON-FENCED TEXT (ASYNC)
        // ------------------------------------------------------------
        const { blocks: pumlBlocksInfo, placeholders } = extractInlinePumlBlocks(contentWithPlaceholders);
        logger.debug("ui: updatePreview"," Inline PUML blocks found: ", pumlBlocksInfo.length);

        let contentWithPumlPlaceholders = contentWithPlaceholders;
        for (let i = 0; i < pumlBlocksInfo.length; i++) {
            logger.debug("ui: updatePreview"," pumlBlocksInfo[i].original: ", pumlBlocksInfo[i].original);
            contentWithPumlPlaceholders = contentWithPumlPlaceholders.replace(pumlBlocksInfo[i].original, placeholders[i]);
            logger.debug("ui: updatePreview"," pumlBlocksInfo[i].content: ", pumlBlocksInfo[i].content);
        }
        logger.debug("ui: updatePreview"," contentWithPumlPlaceholders: ", contentWithPumlPlaceholders);

        // For the async render loop, you just need the inner content:
        const pumlBlocks = pumlBlocksInfo.map(b => b.content);


        // Now render each PUML block asynchronously
        const renderedPumlBlocks = [];
        for (let i = 0; i < pumlBlocks.length; i++) {
            const block = pumlBlocks[i];

            // Resolve !include name:... inside the PUML file
            const withNames = resolvePumlIncludeNames(block, tree);
            // Resolve !include app://file/... inside the PUML file
            const resolvedBlock = resolvePumlIncludes(withNames, tree);

            try {
                const rendered = await renderPuml(resolvedBlock);
                renderedPumlBlocks[i] = rendered;
            } catch (e) {
                renderedPumlBlocks[i] = `<pre style="color:red;">PUML render error:\n${e}\n\n${resolvedBlock}</pre>`;
            }
        }

        // Put rendered PUML back into the content
        let processed = contentWithPumlPlaceholders;
        for (let i = 0; i < renderedPumlBlocks.length; i++) {
            const html = renderedPumlBlocks[i];

            // ⭐ FIX: force block‑level HTML so Markdown won't escape it
            const wrapped = `\n\n<div class="puml-diagram">\n${html}\n</div>\n\n`;

            processed = processed.replace(`@@PUML_${i}@@`, wrapped);
        }
        logger.debug("ui: updatePreview"," processed: ", processed);


        // ------------------------------------------------------------
        //  STEP 3: RESTORE FENCED CODE BLOCKS UNTOUCHED
        //
        // Now we put back each ```...``` block exactly where it was.
        // Any PUML inside these blocks remains literal code and is NOT rendered.
        // ------------------------------------------------------------
        const restored = processed.replace(/@@FENCE_(\d+)@@/g, (match, idxStr) => {
            const idx = Number(idxStr);
            return fencedBlocks[idx] ?? match;
        });

        // ------------------------------------------------------------
        //  STEP 4: FINAL MARKDOWN RENDER
        // ------------------------------------------------------------

        // Auto-link bare internal IDs like: app://file/<id>
        const autoLinkRegex = /(?<!["(>])\bapp:\/\/file\/([A-Za-z0-9-]+)\b/g;

        logger.debug("ui: updatePreview", "RESTORED BEFORE AUTOLINK:", restored);

        const autoLinked = restored.replace(autoLinkRegex, (match, id) => {
            return `<a href="app://file/${id}">${match}</a>`;
        });

        try {
            // IMPORTANT: render autoLinked, not restored
            preview.innerHTML = `<div class="prose">${marked.parse(autoLinked)}</div>`;

            // ------------------------------------------------------------
            //  MAKE INTERNAL LINKS CLICKABLE (app://file/<id>)
            // ------------------------------------------------------------
            const internalLinks = preview.querySelectorAll('a[href^="app://file/"]');

            internalLinks.forEach(a => {
                a.addEventListener("click", (e) => {
                    e.preventDefault();

                    const href = e.currentTarget.getAttribute("href");
                    const id = href.replace("app://file/", "");

                    logger.debug("ui: updatePreview", "Internal link clicked:", id);

                    // Push the page we are leaving
                    if (activeFileId && activeFileId !== id) {
                        history.pushState({ fileId: activeFileId }, "", `#${activeFileId}`);
                    }

                    // Push the page we are going to
                    history.pushState({ fileId: id }, "", `#${id}`);

                    loadFile(id);
                });
            });


        } catch (e) {
            logger.error("ui: updatePreview", "Markdown rendering failed:", e);
            preview.innerHTML = `<pre style="color:red;">Markdown rendering error:\n${e}</pre>`;
        }
    } catch (e) {
        console.error("updatePreview() global error:", e);
    }
}

function extractInlinePumlBlocks(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    const placeholders = [];

    let inside = false;
    let current = [];
    let original = [];
    let index = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inside) {
            if (line.includes("@startuml")) {
                inside = true;
                current = [];
                original = [];

                original.push(line);

                const after = line.split("@startuml")[1];
                if (after.trim()) current.push(after);

                placeholders.push(`@@PUML_${index}@@`);
                index++;
            }
        } else {
            original.push(line);

            if (line.includes("@enduml")) {
                const before = line.split("@enduml")[0];
                if (before.trim()) current.push(before);

                blocks.push({
                    content: current.join("\n"),
                    original: original.join("\n")
                });

                inside = false;
            } else {
                current.push(line);
            }
        }
    }

    return { blocks, placeholders };
}


function getPumlRenderUrl(puml) {
    logger.debug("ui", () => "Running getPumlRenderUrl(). CALLED BY: " + getCallerName("getPumlRenderUrl"));
    try {
        const encoded = plantumlEncoder.encode(puml.trim());
        logger.debug("ui: getPumlRenderUrl. Pre send to Plant: ",puml.trim());
        // return `https://www.plantuml.com/plantuml/svg/${encoded}`; // this is the latest beta release - flakey.  Changing away from this will change the rendering
        // this is another one: https://plantuml.moesol.com/plantuml/svg/${encoded} These came from Gemini   
        return `https://www.planttext.com/api/plantuml/svg/${encoded}`; // this is a Stable PlantUML Proxy - reasonably old potentially    
    } catch (e) {
        logger.error("ui: getPumlRenderUrl", "Encoding error:", e);
        return "";
    }
}

async function renderPumlViaKroki(puml) {
    // 'Kroki is excellent because it is extremely stable and often uses the latest official releases rather than beta snapshots.'
    // renering is slower than PlantUML rendering
    logger.debug("ui", () => "Running renderPumlViaKroki(). CALLED BY: " + getCallerName("renderPumlViaKroki"));
    let res;

    try {
        res = await fetch("https://kroki.io/plantuml/svg", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: puml.trim()
        });
    } catch (networkErr) {
        throw new Error("Network error contacting Kroki: " + networkErr.message);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => "(no error body)");
        throw new Error(`Kroki render failed (${res.status}): ${errText}`);
    }

    const text = await res.text();
    if (!text || !text.trim()) {
        throw new Error("Kroki returned an empty response.");
    }

    const trimmed = text.trim();

    // JSON error?
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        throw new Error("Kroki returned JSON instead of SVG:\n" + trimmed);
    }

    // HTML error?
    if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
        throw new Error("Kroki returned HTML instead of SVG:\n" + trimmed);
    }

    // Find <svg> even if XML header exists
    const svgIndex = trimmed.indexOf("<svg");
    if (svgIndex === -1) {
        throw new Error("Kroki returned non-SVG output:\n" + trimmed);
    }

    // Strip XML header
    return trimmed.slice(svgIndex);
}




function getPumlHref(puml) {
    try {
        const encoded = plantumlEncoder.encode(puml.trim());
        //return `https://www.plantuml.com/plantuml/uml/${encoded}`; //small editor window with no edit capabilities - this is the latest beta release - flakey.  Changing away from this will change the rendering
        return `https://editor.plantuml.com/uml/${encoded}`; // large editor window with edit capabilities - this is the latest beta release - flakey.  Changing away from this will change the rendering
    } catch (e) {
        console.error("Encoding error:", e);
        return "";
    }
}

function openFileById(id) {
    activeFileId = id;
    const tree = getWorkspace();
    const file = findNodeById(tree, id);
    if (!file) return;

    document.getElementById("editor-textarea").value = file.content;
    updatePreview();
}

/*
export function resolvePumlIncludeNames(pumlText, tree) {
    logger.debug("ui: resolvePumlIncludeNames", "Starting include by name resolution. CALLED BY: " + getCallerName("resolvePumlIncludeNames"));
    const mapFile = findNodeByName(tree, "_name_ID_Mapping.puml");
    if (!mapFile) return pumlText;

    const mapping = parseMapping(mapFile.content);

    const regex = /!include\s+name:([A-Za-z0-9_.-]+)/g;

    return pumlText.replace(regex, (full, name) => {
        const resolved = mapping[name];
        if (!resolved) {
            return `!error Unknown include name: ${name}`;
        }
        return `!include ${resolved}`;
    });
}
*/

export function resolvePumlIncludeNames(pumlText, tree) {
    logger.debug("ui: resolvePumlIncludeNames", () => "Starting include by name resolution. CALLED BY: " + getCallerName("resolvePumlIncludeNames"));

    const mapFileName = "_name_ID_Mapping.puml";
    const mapFile = findNodeByName(tree, mapFileName);

    if (!mapFile) {
        logger.warn("ui: resolvePumlIncludeNames", `Mapping file NOT FOUND: ${mapFileName}`);
        return pumlText;
    }

    const mapping = parseMapping(mapFile.content);

    const regex = /!include\s+name:([A-Za-z0-9_.-]+)/g;

    const rewritten = pumlText.replace(regex, (full, name) => {
        const resolved = mapping[name];
        if (!resolved) {
            logger.error("ui: resolvePumlIncludeNames", `No mapping found for '${name}'`);
            return `!error Unknown include name: ${name}`;
        }
        return `!include ${resolved}`;
    });

    return rewritten;
}


/*
function findNodeByName(tree, name) {
    if (!tree) return null;

    // Depth-first search
    const stack = [tree];

    while (stack.length > 0) {
        const node = stack.pop();

        if (node.name === name) {
            return node;
        }

        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                stack.push(child);
            }
        }
    }

    return null;
}
*/
function findNodeByName(tree, name) {
    if (!tree) {
        logger.error("ui: findNodeByName", "Tree is null or undefined");
        return null;
    }

    const stack = Array.isArray(tree) ? [...tree] : [tree];

    while (stack.length > 0) {
        const node = stack.pop();

        if (node.name === name) {
            return node;
        }

        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                stack.push(child);
            }
        }
    }

    logger.warn("ui: findNodeByName", `No match for '${name}'`);
    return null;
}


/*
function parseMapping(text) {
    const map = {};
    const lines = text.split("\n");

    for (const line of lines) {
        const [key, value] = line.split("=").map(s => s.trim());
        if (key && value) map[key] = value;
    }

    return map;
}
*/
function parseMapping(text) {
    const map = {};
    const lines = text.split("\n");

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const parts = line.split("=");
        if (parts.length !== 2) continue;

        const key = parts[0].trim();
        const value = parts[1].trim();

        if (key && value) {
            map[key] = value;
        }
    }

    return map;
}


function resolvePumlIncludes(pumlText, workspace, seenIds = new Set()) {
    logger.debug("ui: resolvePumlIncludes", () => "Starting include resolution. CALLED BY: " + getCallerName("resolvePumlIncludes"));

    try {
        // Matches any fenced code block: ``` ... ```
        const fenceRegex = /```[\s\S]*?```/g;

        // Matches your include syntax: !include app://file/<id>
        const includeRegex = /!include\s+app:\/\/file\/([A-Za-z0-9-]+)/g;

        let result = "";
        let lastIndex = 0;

        // ------------------------------------------------------------
        // Helper: resolve a single include
        // ------------------------------------------------------------
        const resolveOne = (id) => {
            try {
                if (seenIds.has(id)) {
                    logger.warn("ui: resolvePumlIncludes", `Cycle detected for id ${id}`);
                    return `\n' ERROR: include cycle for ${id}\n`;
                }

                const node = findNodeById(workspace, id);
                if (!node || node.type !== "file") {
                    logger.warn("ui: resolvePumlIncludes", `Include target not found: ${id}`);
                    return `\n' ERROR: include target not found: ${id}\n`;
                }

                seenIds.add(id);

                const includedContent = node.content || "";
                logger.debug("ui: resolvePumlIncludes", `Resolving include ${id}, content length ${includedContent.length}`);

                const resolved = resolvePumlIncludes(includedContent, workspace, seenIds);

                seenIds.delete(id);

                return `\n${resolved}\n`;

            } catch (err) {
                logger.error("ui: resolvePumlIncludes", `Error resolving include ${id}:`, err);
                return `\n' ERROR: failed to resolve include ${id}\n`;
            }
        };

        // ------------------------------------------------------------
        // Process text outside fenced blocks
        // ------------------------------------------------------------
        for (const match of pumlText.matchAll(fenceRegex)) {
            const start = match.index;
            const end = start + match[0].length;

            // Text before fenced block
            const outside = pumlText.slice(lastIndex, start);
            result += outside.replace(includeRegex, (full, id) => resolveOne(id));

            // Add fenced block untouched
            result += match[0];

            lastIndex = end;
        }

        // Tail after last fenced block
        const tail = pumlText.slice(lastIndex);
        result += tail.replace(includeRegex, (full, id) => resolveOne(id));

        // write to local storage so avaialble for debugging
        localStorage.setItem("lastPUMLRender", result);

        return result;

    } catch (err) {
        logger.error("ui: resolvePumlIncludes", "Top-level failure:", err);
        return `' ERROR: resolvePumlIncludes failed — see console\n${pumlText}`;
    }
}

export async function copyRenderedPuml() {
    const puml = localStorage.getItem("lastPUMLRender");
    if (!puml) return;

    try {
        await navigator.clipboard.writeText(puml);
    } catch (err) {
        logger.error("ui: copyRenderedPuml", "Failed to copy rendered PUML: " + err);
    }
}

export function addFolder() {

    if (isReadOnlyDevice()) {
        showNotification("info", "Creating folder not allowed on read-only device");
        return;
    }

    const name = prompt("New Folder Name:");
    if (!name || !name.trim()) return;

    const tree = getWorkspace();
    tree.push(createFolder(name.trim()));

    setWorkspace(tree);
    saveState();
    renderSidebar();
}

/* export function collapseAllFolders() {
    document.querySelectorAll(".sidebar-folder-header .chevron.open").forEach(el => {
        el.classList.remove("open");
    });
    document.querySelectorAll(".sidebar-folder-children").forEach(el => {
        el.classList.add("hidden");
    });
}
 */

export function collapseAllFolders() {
    logger.debug("ui: collapseAllFolders", () => "Starting collapse all folders. CALLED BY: " + getCallerName("collapseAllFolders"));

    logger.debug("ui: collapseAllFolders: removed open chevrons", { count: document.querySelectorAll(".sidebar-folder-header .chevron.open").length   });

    const ws = getWorkspace(); // this returns your array of root nodes

    ws.forEach(node => collapseFolderRecursive(node));

    setWorkspace(ws);   // persist the updated state
    renderSidebar();    // rebuild UI
}

function collapseFolderRecursive(node) {
    if (node.type === "folder") {
        node.isOpen = false;
        node.children.forEach(child => collapseFolderRecursive(child));
    }
}

export function addFile(folderId) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Creating file not allowed on read-only device");
        return;
    }

    const name = prompt("File Name:");
    if (!name || !name.trim()) return;



    const isMarkdown = confirm("Press OK for Markdown file, Cancel for PlantUML file");
    const ext = isMarkdown ? ".md" : ".puml";

    const fileName = name.trim().endsWith(ext)
        ? name.trim()
        : name.trim() + ext;

    const tree = getWorkspace();
    const folder = findNodeById(tree, folderId);

    if (!folder || folder.type !== "folder") {
        console.warn("addFile: folder not found", folderId);
        return;
    }

    const newFile = createFile(
        fileName,
        isMarkdown ? `# ${fileName}\n` : "@startuml\n\n@enduml"
    );

    folder.children.push(newFile);
    // Sort children: folders first, then files, alphabetical
    folder.children.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });


    setWorkspace(tree);

    saveState();
    renderSidebar();
    loadFile(newFile.id);
}

export function testFunctionality() {
    const fakeCloud = { id: null, name: "fake.md", content: "test" };
    const fakeMeta = { id: "meta-123" };
    const fakeLocal = { id: "local-123" };

    logIdAnomaly(
        "test-anomaly",
        "/test/path",
        fakeCloud,
        fakeMeta,
        fakeLocal
    );
};

export function exportFile() {
    const tree = getWorkspace();
    const file = findNodeById(tree, activeFileId);

    if (!file || file.type !== "file") {
        showNotification("error", "No file selected to export");
        return;
    }

    const blob = new Blob([file.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();

    showNotification("success", "File exported");
}

export function exportAll() {
    exportWorkspace("manual-export");
    showNotification("success", "Workspace exported");
}

export function buildJsonWorkspaceExport(reason = "manual-export", extra = {}) {
    logger.debug("logger", () => "Running buildJsonWorkspaceExport(). CALLED BY: " + getCallerName("buildJsonWorkspaceExport"));

    try {
        const tree = getWorkspace();
        const flat = flattenWorkspace(tree);

        // Metadata with fallback
        let metadata = getMetadata();
        if (!metadata) {
            try {
                const raw = localStorage.getItem("__workspace_metadata");
                metadata = raw ? JSON.parse(raw) : { error: "metadata unavailable during export" };
            } catch (e) {
                metadata = { error: "metadata unavailable during export" };
            }
        }

        // Extract folders
        const folders = tree
            .filter(n => n.type === "folder")
            .map(n => ({
                id: n.id,
                name: n.name,
                parentId: n.parentId || null
            }));

        // Extract files
        const files = flat.map(f => ({
            id: f.id,
            name: f.name,
            path: f.path,
            content: f.content
        }));

        let gistValue, lastHashValue, syncEnabledValue;

        try { gistValue = getGistId(); }
        catch (e) { logger.error("buildJsonWorkspaceExport", "getGistId() failed: " + e); }

        try { lastHashValue = lastSyncedHash; }
        catch (e) { logger.error("buildJsonWorkspaceExport", "lastSyncedHash failed: " + e); }

        try { syncEnabledValue = getSyncEnabled(); }
        catch (e) { logger.error("buildJsonWorkspaceExport", "getSyncEnabled() failed: " + e); }

        return {
            reason,
            timestamp: new Date().toISOString(),
            device: deviceId,
            gist: gistValue || null,
            lastSyncedHash: lastHashValue || null,
            syncEnabled: syncEnabledValue,
            extra,
            metadata,
            folders,
            files
        };


    } catch (err) {
        logger.error("logger: buildJsonWorkspaceExport", "buildJsonWorkspaceExport FAILED: " + err);
        return { error: "buildJsonWorkspaceExport failed", details: String(err) };
    }
}


export function exportWorkspace(reason = "manual-export", extra = {}) {
    try {    
        // Readable export
        const readable = buildReadableWorkspaceExport(reason, extra);
        const readableBlob = new Blob([readable], { type: "text/plain" });
        const readableUrl = URL.createObjectURL(readableBlob);

        const a1 = document.createElement("a");
        a1.href = readableUrl;
        a1.download = `workspace-${reason}-${getReadableTimestamp()}.txt`;
        a1.click();

        // JSON export (for re-import)
        const json = buildJsonWorkspaceExport(reason, extra);
        logger.debug("ui: exportWorkspace", "buildJsonWorkspaceExport() returned:", json);


        let jsonString;
        try {
            jsonString = JSON.stringify(json, null, 2);
            logger.debug("ui: exportWorkspace", "JSON.stringify succeeded, length:", jsonString.length);
        } catch (e) {
            logger.error("ui: exportWorkspace", "JSON.stringify FAILED: " + e);
            return; // stop export, nothing else to do
        }

        const jsonBlob = new Blob([jsonString], {
            type: "application/json"
        });

        const jsonUrl = URL.createObjectURL(jsonBlob);

        const a2 = document.createElement("a");
        a2.href = jsonUrl;
        a2.download = `workspace-${reason}-${getReadableTimestamp()}.json`;
        a2.click();
    } catch (e) {
        logger.error("ui: exportWorkspace", "Export failed: " + e);
    }

}

function getReadableTimestamp() {
    const d = new Date();

    const pad = (n) => String(n).padStart(2, "0");

    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());

    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());

    return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

export async function importWorkspace(json) {
    try {
        logger.debug("ui.importWorkspace", () => "Starting workspace import. CALLED BY: " + getCallerName("importWorkspace"));

        if (!json || !Array.isArray(json.metadata)) {
            throw new Error("Invalid workspace import format: missing metadata");
        }

        const tree = JSON.parse(JSON.stringify(json.metadata)); // deep clone

        logger.debug("ui.importWorkspace", "Metadata nodes:", tree.length);

        // Attach file contents
        if (Array.isArray(json.files)) {
            for (const fileNode of tree) {
                if (fileNode.type === "file") {
                    const match = json.files.find(f => f.id === fileNode.id);
                    if (match) {
                        fileNode.content = match.content;
                    } else {
                        logger.error("import", "Missing file content for:", fileNode.id, fileNode.name);
                        fileNode.content = "";
                    }
                }
            }
        }

        // gets a couple of samples, since teh structure is so big
        logger.debug("ui.importWorkspace", "Sample folder:", tree.find(n => n.type === "folder"));
        logger.debug("ui.importWorkspace", "Sample file:", tree.find(n => n.type === "file"));
        
        logger.debug("ui.importWorkspace", "Tree after attaching content:", tree);

        if (!confirm("This will replace your entire workspace. Continue?")) {
            showNotification("info", "Import cancelled");
            return;
        }


        // Inflate flat metadata into nested tree
        const byId = new Map(tree.map(n => [n.id, n]));

        for (const node of tree) {
            if (node.type === "folder" && Array.isArray(node.children)) {
                node.children = node.children
                    .map(id => byId.get(id))
                    .filter(Boolean);
            }
        }

        //FIX for flat files added to tree - hopefully
        // Build a set of root folder IDs from json.folders
        const rootIds = new Set(
            json.folders
                .filter(f => f.parentId === null)
                .map(f => f.id)
        );

        // Extract only the root nodes from the inflated tree
        const rootNodes = tree.filter(n => rootIds.has(n.id));
        

        // Save workspace
        setWorkspace(rootNodes);
        saveState();

        // Restore sync metadata
        if (json.lastSyncedHash) {
            localStorage.setItem("lastSyncedHash", json.lastSyncedHash);
        }
        // leave syncEnabled as it was prior to import
        /*
        if (json.syncEnabled !== undefined) {
            localStorage.setItem("syncEnabled", json.syncEnabled);
        }
        */

        // Refresh UI
        refreshUIAfterImport();

        showNotification("info", "Workspace imported successfully");

    } catch (err) {
        logger.error("ui: importWorkspace", "Workspace import failed:", err);
        showNotification("error", "Workspace import failed: " + err.message);
    }
}



function refreshUIAfterImport() {
    // Whatever you normally call after setWorkspace()
    renderSidebar();
    updateToolbarVisibility();
    // Optionally: load the first file or clear the editor
}



function findParentIdFromPath(path, tree) {
    const parts = path.split("/");
    parts.pop(); // remove filename

    if (parts.length === 0) return null;

    const folderName = parts.join("/");
    const folder = tree.find(n => n.type === "folder" && n.name === folderName);
    return folder ? folder.id : null;
}

export function deleteFile(fileId) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Delete not allowed on read-only device");
        return;
    }  

    const tree = getWorkspace();
    const result = findNodeAndParent(tree, fileId);

    if (!result || result.node.type !== "file") return;

    const { node, parent } = result;

    if (!confirm(`Delete file "${node.name}"?`)) return;

    parent.children = parent.children.filter(c => c.id !== fileId);

    if (activeFileId === fileId) {
        activeFileId = null;
        document.getElementById("workspace-grid").classList.add("hidden");
        document.getElementById("empty-state").classList.remove("hidden");
    }

    updateToolbarVisibility();
    setWorkspace(tree);
    saveState();
    renderSidebar();
}


export function renameFile(fileId) {

    if (isReadOnlyDevice()) {
        showNotification("info", "Rename not allowed on read-only device");
        return;
    }  

    const tree = getWorkspace();
    const file = findNodeById(tree, fileId);

    if (!file || file.type !== "file") return;

    const newName = prompt("Rename file:", file.name);
    if (!newName || !newName.trim()) return;

    file.name = newName.trim();

    setWorkspace(tree);
    saveState();
    renderSidebar();

    if (activeFileId === fileId) {
        document.getElementById("active-file-title").textContent = file.name;
        updateToolbar();
    }
}


export function bindPaneFocusEvents() {
    window.activePane = "editor";

    const editor = document.getElementById("editor-textarea");
    const preview = document.getElementById("preview-pane");

    editor?.addEventListener("focus", () => window.activePane = "editor");
    preview?.addEventListener("click", () => window.activePane = "preview");
}

export function zoomEditor(delta) {
    const root = document.documentElement;
    const current = parseFloat(getComputedStyle(root).getPropertyValue("--editor-font-size"));
    const next = Math.min(40, Math.max(10, current + delta));
    root.style.setProperty("--editor-font-size", next + "px");
}

export function zoomPreview(delta) {
    const root = document.documentElement;

    // text zoom
    const currentFont = parseFloat(getComputedStyle(root).getPropertyValue('--preview-font-size'));
    const nextFont = Math.min(32, Math.max(8, currentFont + delta));
    root.style.setProperty('--preview-font-size', nextFont + "px");

    // image zoom
    const currentScale = parseFloat(getComputedStyle(root).getPropertyValue('--preview-zoom-scale'));
    const nextScale = Math.min(3, Math.max(0.5, currentScale + delta * 0.1));
    root.style.setProperty('--preview-zoom-scale', nextScale);
}


export function resetZoom() {
    const root = document.documentElement;

    // Editor text size
    root.style.setProperty("--editor-font-size", "14px");

    // Preview text size
    root.style.setProperty("--preview-font-size", "16px");

    // SVG true-zoom scale (your Option B)
    root.style.setProperty("--preview-zoom-scale", "1");
}

export function setSyncStatus(state, text) {
    const el = document.getElementById("sync-status");
    if (!el) return;

    el.className = `sync-status sync-${state}`;
    el.textContent = text;
}

export function showNotification(type, text) {
    const el = document.getElementById("notification");
    if (!el) return;

    el.className = "notification";
    el.classList.add(`notification-${type}`, "show");

    // Allow HTML - needed for reconnect link
    el.innerHTML = text;

    clearTimeout(notificationTimeout);
    notificationTimeout = setTimeout(() => {
        el.classList.remove("show");
    }, 5000);
}


export function updateLoginIndicator() {
    logger.debug("ui", () => "Running updateLoginIndicator(). CALLED BY: " + getCallerName("updateLoginIndicator"));

    // Update GitHub login button
    const loginBtn = document.getElementById("github-login");
    if (!loginBtn) {
        logger.debug("ui: updateLoginIndicator", "login button not yet in DOM");
        return;
    }

    try {
        const token = getToken();
        const gistId = getGistId();    
        const loggedIn = !!token && !!gistId;  // A user is only "logged in" if BOTH token and gistId exist

        // Clean slate - seems old states being held
        loginBtn.classList.remove("github-logged-in", "github-login-needed");

        if (loginBtn) {
            if (loggedIn) {
                loginBtn.classList.remove("github-login-needed");
                loginBtn.classList.add("github-logged-in");
                loginBtn.textContent = "Connected to Cloud";
            } else {
                loginBtn.classList.remove("github-logged-in");
                loginBtn.classList.add("github-login-needed");
                loginBtn.textContent = "Sign in to cloud";
            }
        }

        updateToolbarVisibility();

        // Cloud‑action buttons to toggle
        const cloudButtons = [
            "save-btn",
            "load-btn",
            "restore-btn",
            "delete-btn"
        ];

        cloudButtons.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            el.disabled = !loggedIn;

            if (!loggedIn) {
                el.classList.add("cloud-disabled");
            } else {
                el.classList.remove("cloud-disabled");
            }
        });

    } catch (err) {
        logger.error("ui: updateLoginIndicator", err);
    }    
}

export function bindEditorEvents() {
    logger.debug("ui", () => "Running bindEditorEvents(). CALLED BY: " + getCallerName("bindEditorEvents"));
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    bindSmartKeyboardEvents(textarea);
    bindGlobalShortcuts(textarea);
    bindScrollSync(textarea);
    bindToolbarEvents(textarea);
    bindPopupEvents(textarea);
    bindSidebarEvents();
}

export function applyClearFormatting(textarea) {
    // store previous value for one-level undo
    textarea.dataset.lastFormatValue = textarea.value;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);

    // Remove HTML tags
    let cleaned = selected
        .replace(/<\/?span[^>]*>/gi, "")
        .replace(/<\/?u>/gi, "")
        .replace(/<\/?mark>/gi, "");

    // Remove Markdown formatting
    cleaned = cleaned
        // 1. FENCED CODE BLOCKS FIRST
        .replace(/```[\s\S]*?```/g, match => {
            return match.replace(/```/g, "");
        })

        // 2. INLINE FORMATTING
        .replace(/\*\*(.*?)\*\*/g, "$1")   // bold
        .replace(/\*(.*?)\*/g, "$1")       // italic
        .replace(/__(.*?)__/g, "$1")       // bold alt
        .replace(/_(.*?)_/g, "$1")         // italic alt
        .replace(/~~(.*?)~~/g, "$1")       // strike

        // 3. INLINE CODE — SINGLE LINE ONLY
        .replace(/`([^`\n]+)`/g, "$1")

        // 4. LISTS
        .replace(/^\s*[-*]\s+/gm, "")      // unordered list
        .replace(/^\s*\d+\.\s+/gm, "")     // ordered list

        // 5. INDENTED CODE BLOCKS
        .replace(/^( {4}|\t)/gm, "");


        
    // Replace selection
    textarea.value =
        textarea.value.substring(0, start) +
        cleaned +
        textarea.value.substring(end);

    textarea.selectionStart = start;
    textarea.selectionEnd = start + cleaned.length;
    textarea.dispatchEvent(new Event("input"));
}

export function applyColorFormat(color, textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);

    const replacement = `<span style="color:${color}">${selected}</span>`;

    textarea.value =
        textarea.value.substring(0, start) +
        replacement +
        textarea.value.substring(end);

    textarea.selectionStart = start;
    textarea.selectionEnd = start + replacement.length;
    textarea.dispatchEvent(new Event("input"));
}

function hidePopups(except) {
    for (const p of document.querySelectorAll('.md-popup')) {
        if (p !== except) p.classList.add("hidden");
    }
}

export function toggleColorPopup(button) {
    const popup = document.getElementById("md-color-popup");

    // Hide all other popups
    hidePopups(popup);

    popup.classList.toggle("hidden");

    // Position popup under the button
    const rect = button.getBoundingClientRect();
    popup.style.left = rect.left + "px";
    popup.style.top = rect.bottom + "px";
}

export function toggleBgColorPopup(button) {
    const popup = document.getElementById("md-bgcolor-popup");

    // Hide all other popups
    hidePopups(popup);

    popup.classList.toggle("hidden");

    // Position popup under the button
    const rect = button.getBoundingClientRect();
    popup.style.left = rect.left + "px";
    popup.style.top = rect.bottom + "px";
}

export function toggleTablePopup(button) {
    const popup = document.getElementById("table-popup");

    // Hide all other popups
    hidePopups(popup);

    // Toggle visibility
    popup.classList.toggle("hidden");

    if (!popup.classList.contains("hidden")) {
        const rect = button.getBoundingClientRect();
        popup.style.left = rect.left + "px";
        popup.style.top = rect.bottom + "px";
    }
}

export function applyBgColorFormat(bg, textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);

    const replacement = `<span style="background-color:${bg}">${selected}</span>`;

    textarea.value =
        textarea.value.substring(0, start) +
        replacement +
        textarea.value.substring(end);

    textarea.selectionStart = start;
    textarea.selectionEnd = start + replacement.length;
    textarea.dispatchEvent(new Event("input"));
}


// Sidebar toggle for mobile
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("sidebar-toggle").addEventListener("click", () => {
        document.body.classList.toggle("sidebar-open");
    });
});

document.getElementById("toggle-editor").addEventListener("click", () => {
    toggleEditorVisibility();
});

function toggleEditorVisibility() {
    const grid = document.querySelector(".workspace-grid");
    const btn = document.getElementById("toggle-editor");

    grid.classList.toggle("editor-hidden");

    btn.textContent = grid.classList.contains("editor-hidden")
        ? "Show Source"
        : "Hide Source";
}

function hideEditor() {
    const grid = document.querySelector(".workspace-grid");
    const btn = document.getElementById("toggle-editor");

    grid.classList.add("editor-hidden");
    btn.textContent = "Show Source";
}

export function showCountdownNotification({ countdown, onConfirm, onCancel }) {
    logger.debug("ui", () => "Running showCountdownNotification(). CALLED BY: " + getCallerName("showCountdownNotification"));

    if (isReadOnlyDevice()) { return; }
        
    const el = document.getElementById("notification");
    if (!el) {
        logger.info("ui: showCountdownNotification", "Couldn't find element 'notification'");
        return;
    }

    clearTimeout(notificationTimeout);
    clearInterval(countdownInterval);

    try {
        let remaining = countdown;

        function bindCancel() {
            const cancel = el.querySelector("#cancel-countdown");
            if (cancel) {
                cancel.onclick = () => {
                    logger.debug("ui: countdown", "User CANCELLED the countdown to sync with cloud");
                    clearInterval(countdownInterval);
                    el.classList.remove("show");
                    onCancel();
                };
            }
        }

        function render() {
            el.className = "notification notification-countdown show";
            el.innerHTML = `
                Overwriting with newer cloud version in <strong>${remaining}</strong> seconds.
                <a id="cancel-countdown">Cancel</a>
            `;
            bindCancel();   // must be called after every render
        }

        render();

        countdownInterval = setInterval(() => {
            remaining--;
            render();

            if (remaining <= 0) {
                logger.debug("ui: countdown", "Countdown reached zero → AUTO-CONFIRM sync with cloud");
                clearInterval(countdownInterval);
                el.classList.remove("show");
                onConfirm();
            }
        }, 1000);

    } catch (error) {
        logger.error("ui: showCountdownNotification", error);
        return;
    }
    
    // did the dialog is disappearing without calling onCancel or onConfirm. This can happen if the user clicks outside the dialog or presses Escape. In this case, we want to log a warning.
    setTimeout(() => {
        const isVisible = el.classList.contains("show");
        if (!isVisible) {
            logger.warn("ui: countdown", "Dialog closed WITHOUT confirm/cancel");
        }
    }, 0);
    
}




// for testing purposes
//if (location.hostname === "localhost") {
//    window.showCountdownNotification = showCountdownNotification;
//}
/* Use with:
From Console:
showCountdownNotification({
    countdown: 10,
    onConfirm: () => console.log("CONFIRMED"),
    onCancel: () => console.log("CANCELLED")
});
*/

