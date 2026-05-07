/*Where to place code:
If it changes text → md-editor.js, likely starting bindEditorEvents()
If it changes UI → ui.js, likely starting applyMarkdownFormat()
*/

// md-editor.js (top of file or near other exports)

import { logger } from "./logger.js";

logger.debug("md-editor","md-editor.js loaded from:", import.meta.url);

export function setupMarked() {
    logger.debug("md-editor", "setupMarked()");

    // Allow raw HTML so inline diagrams render correctly
    marked.setOptions({
        gfm: true,
        breaks: true,
        mangle: false,
        headerIds: false,
        sanitize: false   // ← REQUIRED for both PlantUML and Kroki
    });

    const renderer = new marked.Renderer();

    // Keep lists tight but paragraphs spaced
    renderer.list = function (body, ordered) {
        const type = ordered ? "ol" : "ul";
        return `<${type}>\n${body}</${type}>\n\n`;
    };

    // Add heading IDs for TOC
    renderer.heading = function (text, level) {
        const id = text
            .toLowerCase()
            .replace(/[^\w]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return `<h${level} id="${id}">${text}</h${level}>`;
    };

    marked.use({ renderer });
}

export function applyMarkdownFormat(type, textarea) {
    logger.debug("md-editor", "applyMarkdownFormat()");
    // store previous value for one-level formatting undo
    textarea.dataset.lastFormatValue = textarea.value;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);

    let before = "";
    let after = "";
    let replacement = selected;

    switch (type) {
        case "bold":
            before = "**"; after = "**";
            break;
        case "italic":
            before = "*"; after = "*";
            break;
        case "underline":
            replacement = `<u>${selected}</u>`;
            break;
        case "strike":
            replacement = `~~${selected}~~`;
            break;
        case "h1":
            replacement = `# ${selected}`;
            break;
        case "link":
            insertLink(selected);
            return;

            break;
        case "code": {
            const lines = selected.split("\n");

            if (lines.length === 1) {
                // inline code
                before = "`";
                after = "`";
            } else {
                // fenced code block
                replacement = "```\n" + selected + "\n```";
                before = "";
                after = "";
            }
            break;
        }
        case "quote": {
            const lines = selected.split("\n");
            replacement = lines
                .map(line => line.trim() ? `> ${line.trim()}` : ">")
                .join("\n");
            break;
        }
        case "ul": {
            const lines = selected.split("\n");
            // If already a list, this will "toggle" it off or indent it
            replacement = lines.map(line => {
                if (line.trim().startsWith('- ')) {
                    return '  ' + line; // Indent if already a list item
                }
                return `- ${line.trim()}`;
            }).join("\n");
            break;
        }
        case "ol": {
            let i = 1;
            const lines = selected.split("\n");
            replacement = lines
                .map(line => line.trim() ? `${i++}. ${line.trim()}` : "")
                .join("\n");
            break;
        }

        case "date": {
            const insert = new Date().toISOString().split("T")[0];
            textarea.setRangeText(insert, start, end, "end");
            // Ensure cursor lands after the inserted date, and see code at end to complete positioning
            textarea.dataset.forceCursor = start + insert.length;
            break;
        }

        case "br": {
            const insert = "<br>\n";
            textarea.setRangeText(insert, start, end, "end");
            // Ensure cursor lands after the inserted BR, and see code at end to complete positioning
            textarea.dataset.forceCursor = start + insert.length;
            break;
        }

        case "hr":
            replacement = `\n***\n`;
            break;
        case 'table-insert-2x2':
            insertAtCursor(generateTable(2, 2));
            break;

        case 'table-insert-3x3':
            insertAtCursor(generateTable(3, 3));
            break;

        case 'table-insert-4x4':
            insertAtCursor(generateTable(4, 4));
            break;
        case 'table-add-row':
            addTableRowBelow();
            return;
        case 'table-add-col':
            addTableColumnRight();
            return;
        case 'table-del-row':
            deleteTableRow();
            return;
        case 'table-del-col':
            deleteTableColumn();
            return;
        case 'table-format':
            formatTable();
            return;
        case "puml": {
            const snippet = "\n```puml\n@startuml\nparticipant Alice\nparticipant Bob\n\nAlice -> Bob: Hello\n@enduml\n```\n";
            textarea.setRangeText(snippet, start, end, "end");
            }
            break;
        case 'convertMD': 
            convertToMarkdown();
            return;
        case 'insert-expand': 
            insertExpand();
            return;

    }
    // when this code runs, any just inserted text (like date or BR) is already in place, so we use the original start position and the length of the replacement to set the cursor correctly after insertion
    textarea.setRangeText(before + replacement + after, start, end, "end");

    // restore cursor without breaking undo
    const cursorStart = start + before.length;
    const cursorEnd = cursorStart + replacement.length;

    textarea.selectionStart = cursorStart;
    textarea.selectionEnd = cursorEnd;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));

    // place the cursor an then end of the inserted text (for cases like date where we want to continue typing after)
    if (textarea.dataset.forceCursor) {
        const pos = parseInt(textarea.dataset.forceCursor, 10);
        textarea.selectionStart = textarea.selectionEnd = pos;
        delete textarea.dataset.forceCursor;
    }


}

function insertAtCursor(text) {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);

    // Insert the text
    textarea.value = before + text + after;

    // Move cursor to the end of the inserted text
    const newPos = start + text.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;

    textarea.focus();
    textarea.dispatchEvent(new Event("input")); // triggers updatePreview()
}


function generateTable(rows, cols) {
    let header = '| ' + Array.from({length: cols}, (_, i) => `Col ${i+1}`).join(' | ') + ' |\n';
    let divider = '| ' + Array.from({length: cols}, () => '------').join(' | ') + ' |\n';
    let body = '';

    for (let r = 0; r < rows; r++) {
        body += '| ' + Array.from({length: cols}, () => '').join(' | ') + ' |\n';
    }

    return header + divider + body;
}

function normalizeRow(cells) {
    return "| " + cells.map(c => c.trim()).join(" | ") + " |";
}
const isDividerRow = row => row.trim().match(/^\|(\s*-+\s*\|)+$/);


/* addTableRowBelow: Find the current line based on cursor position
Check if it’s a table row (contains |)
Count the number of cells
Generate a new empty row with the same number of cells
Insert it below the current row
Rebuild the textarea value
Place the cursor inside the first cell of the new row */
export function addTableRowBelow() {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;
    const cursor = textarea.selectionStart;

    const lines = value.split("\n");

    // Find the current line index based on cursor position
    let lineIndex = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1; // +1 for newline
        if (charCount > cursor) {
            lineIndex = i;
            break;
        }
    }

    // Ensure we're inside a table row (must contain pipes)
    if (!lines[lineIndex].includes("|")) {
        return; // not in a table
    }

    // Determine the number of cells in the current row
    const currentRow = lines[lineIndex];
    const cellCount = currentRow.split("|").length - 2;

    // Build a new empty row
    const newRow =
        "| " +
        Array.from({ length: cellCount }, () => "").join(" | ") +
        " |";

    // Insert the new row below the current one
    const insertedRowIndex = lineIndex + 1;
    lines.splice(insertedRowIndex, 0, newRow);

    // Rebuild the text
    const newText = lines.join("\n");
    textarea.value = newText;

    // Compute cursor position based on the UPDATED text
    let newCursorPos = 0;
    for (let i = 0; i < insertedRowIndex; i++) {
        newCursorPos += lines[i].length + 1;
    }

    // Place cursor inside the first cell ("| ")
    textarea.selectionStart = textarea.selectionEnd = newCursorPos + 2;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
}


/* addTableColumnRight: Find the current line
Check if it’s a table row
Determine the column index by counting pipes before the cursor
Find the entire table block (continuous lines with |)
Insert a new empty cell into every row at the correct column index
Rebuild the textarea value
Place the cursor inside the new cell */
export function addTableColumnRight() {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;
    const cursor = textarea.selectionStart;

    const lines = value.split("\n");

    // Find the current line index
    let lineIndex = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > cursor) {
            lineIndex = i;
            break;
        }
    }

    // Ensure we're inside a table row
    if (!lines[lineIndex].includes("|")) {
        return; // not in a table
    }

    // Determine column index based on cursor position
    const lineStartPos = charCount - (lines[lineIndex].length + 1);
    const cursorInLine = cursor - lineStartPos;

    // Count pipes before cursor to determine column index
    const beforeCursor = lines[lineIndex].substring(0, cursorInLine);
    const colIndex = beforeCursor.split("|").length - 2; 
    // -2 because split gives empty strings at start/end

    // Identify the table block (continuous lines with pipes)
    let start = lineIndex;
    let end = lineIndex;

    while (start > 0 && lines[start - 1].includes("|")) start--;
    while (end < lines.length - 1 && lines[end + 1].includes("|")) end++;

    // Update each row in the table block
    for (let i = start; i <= end; i++) {
        const row = lines[i].split("|");

        // Determine if this is the divider row
        const rawLine = lines[i];
        const divider = isDividerRow(rawLine);

        const insertPos = colIndex + 2;

        // Insert correct cell type
        if (divider) {
            row.splice(insertPos, 0, "------");   // divider cell
        } else {
            row.splice(insertPos, 0, " ");        // normal empty cell
        }

        lines[i] = normalizeRow(row.slice(1, -1));
    }


    // Rebuild text
    const newText = lines.join("\n");
    textarea.value = newText;

    // Move cursor to the new cell
    let newCursorPos = 0;
    for (let i = 0; i < lineIndex; i++) {
        newCursorPos += lines[i].length + 1;
    }

    // Move into the new cell (roughly)
    newCursorPos += lines[lineIndex].indexOf("|", cursorInLine) + 2;

    textarea.selectionStart = textarea.selectionEnd = newCursorPos;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
}

/* deleteTableRow: Find the current line based on cursor position
Check if it’s a table row
Find the entire table block (continuous lines with |)
Prevent deleting the divider row (the |---|---| row)
Remove the current row
Rebuild the textarea value
Move cursor to the next logical row (same index or previous if at end) */
export function deleteTableRow() {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;
    const cursor = textarea.selectionStart;

    const lines = value.split("\n");

    // Find the current line index
    let lineIndex = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > cursor) {
            lineIndex = i;
            break;
        }
    }

    // Ensure we're inside a table row
    if (!lines[lineIndex].includes("|")) {
        return; // not a table row
    }

    // Identify the table block (continuous lines with pipes)
    let start = lineIndex;
    let end = lineIndex;

    while (start > 0 && lines[start - 1].includes("|")) start--;
    while (end < lines.length - 1 && lines[end + 1].includes("|")) end++;

    // Prevent deleting the header divider row (the --- row)
    const isDividerRow = row => row.trim().match(/^\|(\s*-+\s*\|)+$/);

    // If deleting the divider row, do nothing
    if (isDividerRow(lines[lineIndex])) {
        return;
    }

    // Delete the row
    lines.splice(lineIndex, 1);

    // Rebuild text
    const newText = lines.join("\n");
    textarea.value = newText;

    // Move cursor to the start of the next row (or previous if at end)
    let newCursorPos = 0;
    const targetIndex = Math.min(lineIndex, lines.length - 1);

    for (let i = 0; i < targetIndex; i++) {
        newCursorPos += lines[i].length + 1;
    }

    textarea.selectionStart = textarea.selectionEnd = newCursorPos;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
}

/* deleteTableColumn: Find the current line
Check if it’s a table row
Determine the column index by counting pipes before the cursor
Find the entire table block
Prevent deleting the last column
Prevent deleting the divider row
Remove the column from every row
Rebuild the textarea value
Place cursor safely at the start of the row */
export function deleteTableColumn() {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;
    const cursor = textarea.selectionStart;

    const lines = value.split("\n");

    // Find the current line index
    let lineIndex = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > cursor) {
            lineIndex = i;
            break;
        }
    }

    // Ensure we're inside a table row
    if (!lines[lineIndex].includes("|")) {
        return; // not a table row
    }

    // Determine column index based on cursor position
    const lineStartPos = charCount - (lines[lineIndex].length + 1);
    const cursorInLine = cursor - lineStartPos;

    const beforeCursor = lines[lineIndex].substring(0, cursorInLine);
    const colIndex = beforeCursor.split("|").length - 2; 
    // -2 because split gives empty strings at start/end

    // Identify the table block (continuous lines with pipes)
    let start = lineIndex;
    let end = lineIndex;

    while (start > 0 && lines[start - 1].includes("|")) start--;
    while (end < lines.length - 1 && lines[end + 1].includes("|")) end++;

    // Prevent deleting the last remaining column
    const sampleRow = lines[lineIndex].split("|").length - 2;
    if (sampleRow <= 1) {
        return; // can't delete the only column
    }

    // Prevent deleting the divider row (--- row)
    const isDividerRow = row => row.trim().match(/^\|(\s*-+\s*\|)+$/);
    if (isDividerRow(lines[lineIndex])) {
        return;
    }

    // Update each row in the table block
    for (let i = start; i <= end; i++) {
        const row = lines[i].split("|");

        // row looks like ["", " cell ", " cell ", ""]
        const deletePos = colIndex + 2; 
        // +2 because of leading empty string and 1-based indexing

        row.splice(deletePos, 1);

       lines[i] = normalizeRow(row.slice(1, -1));
    }

    // Rebuild text
    const newText = lines.join("\n");
    textarea.value = newText;

    // Move cursor to the start of the same row (safe fallback)
    let newCursorPos = 0;
    for (let i = 0; i < lineIndex; i++) {
        newCursorPos += lines[i].length + 1;
    }

    textarea.selectionStart = textarea.selectionEnd = newCursorPos;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
}

/*formatTable: detects the table block
splits rows into cells
trims whitespace
computes max width per column
rebuilds the header divider row
pads cells to align pipes
reassembles the table cleanly */
export function formatTable() {
    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;
    const cursor = textarea.selectionStart;

    const lines = value.split("\n");

    // Find current line index
    let lineIndex = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > cursor) {
            lineIndex = i;
            break;
        }
    }

    // Not in a table
    if (!lines[lineIndex].includes("|")) return;

    // Identify table block
    let start = lineIndex;
    let end = lineIndex;

    while (start > 0 && lines[start - 1].includes("|")) start--;
    while (end < lines.length - 1 && lines[end + 1].includes("|")) end++;

    const tableLines = lines.slice(start, end + 1);

    // Parse rows into arrays of trimmed cells
    const rows = tableLines.map(row =>
        row
            .split("|")
            .slice(1, -1) // remove empty edges
            .map(cell => cell.trim())
    );

    const colCount = Math.max(...rows.map(r => r.length));

    // Compute max width per column
    const colWidths = Array(colCount).fill(0);
    rows.forEach(row => {
        row.forEach((cell, i) => {
            colWidths[i] = Math.max(colWidths[i], cell.length);
        });
    });

    // Build formatted rows
    const formatted = rows.map((row, rowIndex) => {
        const paddedCells = row.map((cell, i) =>
            cell.padEnd(colWidths[i], " ")
        );

        const line = "| " + paddedCells.join(" | ") + " |";

        // Divider row (second row)
        if (rowIndex === 1) {
            const divider = "| " +
                colWidths.map(w => "-".repeat(w)).join(" | ") +
                " |";
            return [line, divider];
        }

        return line;
    }).flat();

    // Replace table block
    const newLines = [
        ...lines.slice(0, start),
        ...formatted,
        ...lines.slice(end + 1)
    ];

    textarea.value = newLines.join("\n");

    // Restore cursor to start of same row
    let newCursorPos = 0;
    for (let i = 0; i < lineIndex; i++) {
        newCursorPos += newLines[i].length + 1;
    }

    textarea.selectionStart = textarea.selectionEnd = newCursorPos;

    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
}

function insertExpand() {
    // Save previous value for undo (same pattern as other formats)
    const textarea = document.getElementById("editor-textarea");
    textarea.dataset.lastFormatValue = textarea.value;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const snippet =
`<details>
<summary>Your title here</summary>

Your content here…

</details>
`;

    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);

    // Insert the snippet
    textarea.value = before + snippet + after;

    // Move cursor to the "Your title here" text
    const cursorPos = before.length + snippet.indexOf("Your title here");
    textarea.selectionStart = textarea.selectionEnd = cursorPos;

    textarea.focus();
}

function insertLink(selected) {
    const textarea = document.getElementById("editor-textarea");
    textarea.dataset.lastFormatValue = textarea.value;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const linkText = selected || "text";

    const snippet = `<a href="url" target="_blank" rel="noopener noreferrer">${linkText}</a>`;

    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);

    textarea.value = before + snippet + after;

    // Move cursor to inside the "url"
    const urlPos = before.length + snippet.indexOf("url");
    textarea.selectionStart = urlPos;
    textarea.selectionEnd = urlPos + 3; // highlight "url"

    textarea.focus();
}

function convertToMarkdown() {

    const textarea = document.getElementById("editor-textarea");
    if (!textarea) return;

    const value = textarea.value;

    const lines = value.split(/\r?\n/);
    const output = [];
    let inList = false;

    const isBullet = line => /^\s*[\*\-•]\s+/.test(line);
    const isTitle = line =>
        line.trim().length > 0 &&
        !isBullet(line) &&
        !/[.:]$/.test(line.trim()) &&
        /^[A-Z][A-Za-z0-9\s|&-]*$/.test(line.trim());

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();

        if (line === "") {
            output.push("");
            inList = false;
            continue;
        }

        if (isBullet(line)) {
            if (!inList && output[output.length - 1] !== "") {
                output.push("");
            }

            // *** Normalize bullet marker to "-" ***
            const normalized = line.replace(/^\s*[\*\•]\s+/, "- ");

            output.push(normalized);
            inList = true;
            continue;
        }

        inList = false;

        if (isTitle(line)) {
            output.push("");
            output.push("## " + line.trim());
            output.push("");
            continue;
        }

        output.push(line);
    }

    const markdown = output
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    textarea.value = markdown;
}
