/*
    markdown.js turns the markdown people type in the chat into HTML that is safe to insert.

    Everything that is not markup is escaped, so a message can never inject HTML or scripts;
    the only tags in the output are the ones this file writes. Links open in a new tab and only
    http, https and mailto addresses become links.

    Supported: fenced code blocks (``` or ~~~, with a language), headings, lists (nested), block
    quotes, horizontal rules, tables, paragraphs with line breaks, and inline code, bold, italic,
    strikethrough, links, images and bare URLs. Backslash escapes a markdown character.

    Use: renderMarkdown(text) -> HTML string.
*/
(function (global) {
    "use strict";

    const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
    }

    // Only absolute web addresses and mail addresses become links; anything else stays text.
    function safeUrl(url) {
        const u = url.trim();
        return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
    }

    const PLACEHOLDER = /\u0000(\d+)\u0000/g;

    /*
        Inline markup. Finished pieces of HTML (code spans, links, images, escaped characters) are
        put aside and replaced by placeholders, the remaining text is escaped, the emphasis marks
        are turned into tags, and the pieces are put back.
    */
    function inline(text) {
        const stash = [];
        const keep = (html) => "\u0000" + (stash.push(html) - 1) + "\u0000";

        let s = text
            // \* and the like: the character itself
            .replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, (m, c) => keep(escapeHtml(c)))
            // `code`
            .replace(/(`+)([\s\S]+?)\1(?!`)/g, (m, ticks, code) => keep("<code>" + escapeHtml(code.replace(/\n/g, " ").replace(/^ (?=\S)|(?<=\S) $/g, "")) + "</code>"))
            // ![alt](url)
            .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, url, title) => {
                const href = safeUrl(url);
                if (!href) return m;
                return keep(`<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`);
            })
            // [text](url)
            .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, url, title) => {
                const href = safeUrl(url);
                if (!href) return m;
                return keep(`<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noopener noreferrer">${inline(label)}</a>`);
            })
            // bare addresses: https://example.com/path. Trailing punctuation stays outside the link.
            .replace(/(^|[\s(<])(https?:\/\/[^\s<]+)/g, (m, before, url) => {
                let trail = "";
                const cut = /[.,;:!?'"]+$/.exec(url);
                if (cut) { trail = cut[0]; url = url.slice(0, -trail.length); }
                if (url.endsWith(")") && !url.includes("(")) { trail = ")" + trail; url = url.slice(0, -1); }
                return before + keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) + trail;
            });

        s = escapeHtml(s)
            .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
            .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "<em>$1</em>")
            .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")
            .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");

        return s.replace(PLACEHOLDER, (m, i) => stash[Number(i)]);
    }

    const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
    const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
    const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
    const QUOTE = /^ {0,3}>/;
    const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
    const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
    const BLANK = /^[ \t]*$/;

    function startsBlock(line, next) {
        return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next);
    }

    function isTableStart(line, next) {
        return line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-");
    }

    // Leading width of a line, a tab counting as four columns.
    function indentOf(line) {
        let n = 0;
        for (const c of line) {
            if (c === " ") n += 1;
            else if (c === "\t") n += 4 - (n % 4);
            else break;
        }
        return n;
    }

    // The line without its first `columns` columns of indentation.
    function dedent(line, columns) {
        let n = 0, i = 0;
        while (i < line.length && n < columns) {
            if (line[i] === " ") n += 1;
            else if (line[i] === "\t") n += 4 - (n % 4);
            else break;
            i++;
        }
        return line.slice(i);
    }

    function blocks(lines) {
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (BLANK.test(line)) { i++; continue; }

            // ```lang ... ```  The code is escaped and nothing else; indentation is kept as typed.
            let m = FENCE.exec(line);
            if (m) {
                const close = new RegExp("^ {0,3}" + m[1][0] + "{" + m[1].length + ",}[ \\t]*$");
                const code = [];
                let j = i + 1;
                while (j < lines.length && !close.test(lines[j])) code.push(lines[j++]);
                // the language name goes on the block (shown as a label) and on the code (for a highlighter)
                const lang = /^[\w+#.-]{1,20}$/.test(m[2]) ? m[2].toLowerCase() : "";
                const attrs = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
                const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
                out.push(`<pre${attrs}><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
                i = j + 1;
                continue;
            }

            m = HEADING.exec(line);
            if (m) {
                out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
                i++;
                continue;
            }

            if (RULE.test(line)) {
                out.push("<hr>");
                i++;
                continue;
            }

            if (QUOTE.test(line)) {
                const quoted = [];
                while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ""));
                out.push(`<blockquote>${blocks(quoted)}</blockquote>`);
                continue;
            }

            if (ITEM.test(line)) {
                const r = list(lines, i);
                out.push(r.html);
                i = r.next;
                continue;
            }

            if (isTableStart(line, lines[i + 1])) {
                const r = table(lines, i);
                out.push(r.html);
                i = r.next;
                continue;
            }

            // A paragraph: the lines up to a blank line or the start of another block. In a chat, every
            // line break is meant, so each one becomes <br>.
            const para = [line];
            i++;
            while (i < lines.length && !BLANK.test(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
            out.push(`<p>${inline(para.map((l) => l.trim()).join("\n")).replace(/\n/g, "<br>")}</p>`);
        }

        return out.join("");
    }

    /*
        A list: consecutive items with the same kind of marker at the same indentation. Lines indented
        past an item's marker belong to that item, so an indented list under an item becomes a nested list.
    */
    function list(lines, start) {
        const first = ITEM.exec(lines[start]);
        const indent = indentOf(first[1]);
        const ordered = /\d/.test(first[2]);
        const items = [];
        let i = start;

        while (i < lines.length) {
            const m = ITEM.exec(lines[i]);
            if (!m || indentOf(m[1]) !== indent || /\d/.test(m[2]) !== ordered) break;
            const contentIndent = indent + m[2].length + 1;
            const body = [m[3]];
            i++;
            while (i < lines.length) {
                const l = lines[i];
                if (BLANK.test(l)) {
                    // a blank line inside the item, when more indented text follows
                    if (i + 1 < lines.length && !BLANK.test(lines[i + 1]) && indentOf(lines[i + 1]) >= contentIndent) { body.push(""); i++; continue; }
                    break;
                }
                const w = indentOf(l);
                if (w >= contentIndent) { body.push(dedent(l, contentIndent)); i++; continue; }
                if (w > indent && ITEM.test(l)) { body.push(dedent(l, w)); i++; continue; } // a nested item indented less than the text
                break;
            }
            items.push(body);
        }

        const startAttr = ordered && first[2].replace(/\D/g, "") !== "1" ? ` start="${parseInt(first[2], 10)}"` : "";
        const tag = ordered ? "ol" : "ul";
        const html = items.map((body) => {
            // the item's first paragraph sits directly in the <li>; anything else (a nested list, code) follows it
            let inner = blocks(body);
            inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
            return `<li>${inner}</li>`;
        }).join("");
        return { html: `<${tag}${startAttr}>${html}</${tag}>`, next: i };
    }

    // A table: a header row, a separator row of dashes (with : for alignment), then rows.
    function table(lines, start) {
        const cells = (l) => {
            let t = l.trim();
            if (t.startsWith("|")) t = t.slice(1);
            if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
            return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        };
        const head = cells(lines[start]);
        const align = cells(lines[start + 1]).map((a) => /^:-+:$/.test(a) ? "center" : /-+:$/.test(a) ? "right" : /^:-+$/.test(a) ? "left" : "");
        const rows = [];
        let i = start + 2;
        while (i < lines.length && !BLANK.test(lines[i]) && lines[i].includes("|")) rows.push(cells(lines[i++]));

        const cell = (tag, text, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(text || "")}</${tag}>`;
        let html = `<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>`;
        if (rows.length) html += `<tbody>${rows.map((r) => `<tr>${head.map((c, k) => cell("td", r[k], k)).join("")}</tr>`).join("")}</tbody>`;
        return { html: html + "</table>", next: i };
    }

    function renderMarkdown(text) {
        return blocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
    }

    global.renderMarkdown = renderMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
