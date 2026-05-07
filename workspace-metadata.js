// workspace-metadata.js
import { logger, getCallerName } from "./logger.js";
let currentMetadata = null;

logger.debug("workspace-metadata","workspace-metadata.js loaded from:", import.meta.url);


export function getMetadata() {
    return currentMetadata;
}

export function setMetadata(meta) {
    currentMetadata = meta;
}


export function extractMetadata(nodes) {
    logger.debug("workspace-metadata", () => "Running extractMetadata. CALLED BY: " + getCallerName("extractMetadata"));
    const meta = [];

    function walk(list, parentPath = "") {

        // ------------------------------------------------------------
        // 1. Deterministically sort siblings.
        //
        //    Why?
        //    - Metadata must be stable across devices.
        //    - Sorting ensures the same traversal order everywhere.
        // ------------------------------------------------------------
        const sorted = [...list].sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === "folder" ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        for (const node of sorted) {

            // ------------------------------------------------------------
            // 2. Build a canonical metadata path.
            //
            //    Important:
            //    - We use the *raw* name here (not encoded).
            //    - This preserves your existing metadata format.
            // ------------------------------------------------------------
            const path = parentPath ? `${parentPath}___${node.name}` : node.name;

            // ------------------------------------------------------------
            // 3. Base metadata entry (structural fields).
            //
            //    These fields define the workspace structure.
            //    They WILL be used later for hashing.
            // ------------------------------------------------------------
            const entry = {
                id: node.id,
                type: node.type,
                name: node.name,
                path
            };

            if (node.type === "folder") {

                // ------------------------------------------------------------
                // 4. Folder-specific metadata.
                //
                //    children:
                //      - Sorted for determinism.
                //      - UI fields (isOpen) preserved for saving.
                // ------------------------------------------------------------
                entry.isOpen = !!node.isOpen;
                entry.children = node.children
                    .map(c => c.id)
                    .sort(); // deterministic ordering

                meta.push(entry);

                // Recurse into children
                walk(node.children, path);

            } else {

                // ------------------------------------------------------------
                // 5. File-specific metadata.
                //
                //    UI fields preserved for saving.
                //    These WILL NOT be included in the structural hash later.
                // ------------------------------------------------------------
                entry.isPublic = !!node.isPublic;
                entry.publicId = node.publicId || null;
                entry.publicAt = node.publicAt || null;
                //entry.updatedAt = node.updatedAt || null;

                meta.push(entry);
            }
        }
    }

    walk(nodes);

    // ------------------------------------------------------------
    // 6. Sort final metadata list by path.
    //
    //    Why?
    //    - Ensures stable ordering in __workspace.json.
    //    - Prevents churn when saving from different devices.
    // ------------------------------------------------------------
    meta.sort((a, b) => a.path.localeCompare(b.path));

    return {
        version: 1,
        nodes: meta
    };
}


// workspace-metadata.js

export function applyMetadata(tree, metadata) {
    logger.debug("workspace-metadata", () => "Running applyMetadata. CALLED BY: " + getCallerName("applyMetadata"));
    const map = new Map();
    metadata.nodes.forEach(n => map.set(n.path, n));

    // amend this function if adding a new field
    function walk(nodes, parentPath = "") {
        for (const node of nodes) {
            const nodePath = parentPath
                ? `${parentPath}___${node.name}`
                : node.name;

            const meta = map.get(nodePath);
            if (meta) {
                node.id = meta.id;            // restore ID
                //node.name = meta.name;          // NEVER restore node.name

                if (node.type === "folder") {
                    node.isOpen = !!meta.isOpen;

                    // reorder children
                    node.children.sort((a, b) =>
                        meta.children.indexOf(a.id) -
                        meta.children.indexOf(b.id)
                    );
                } else {
                    node.isPublic = !!meta.isPublic;
                    node.publicId = meta.publicId || null;
                    node.publicAt = meta.publicAt || null;
                    //node.updatedAt = meta.updatedAt || null;
                }
            }

            if (node.children) {
                walk(node.children, nodePath);
            }
        }
    }

    walk(tree);
}

