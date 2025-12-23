// lib/convert.js
(() => {
    const ATTR = "data-scc";
    const ATTR_ORIG = "data-scc-orig";
    const ATTR_EL = "data-scc-el";

    const BAR_ID = "scc-bar-host";
    const PICKER_HOST_ID = "scc-picker-host";

    const EL_ORIG_HTML = new WeakMap();

    function isEditableOrUnsafe(el) {
        if (!el) return true;
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return true;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return true;
        if (el.isContentEditable) return true;
        return false;
    }

    function parseAmount(str) {
        const parser = globalThis.SCCNumber?.parseNumberSmart;
        return typeof parser === "function" ? parser(str) : null;
    }

    function formatMoney(amount, currency) {
        try {
            return new Intl.NumberFormat(undefined, {
                style: "currency",
                currency,
                maximumFractionDigits: 2
            }).format(amount);
        } catch {
            return `${amount.toFixed(2)} ${currency}`;
        }
    }

    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function normalizeTokenToCurrency(token) {
        if (!token) return null;
        const SCC_MAPS = globalThis.SCC_MAPS || {};
        const t = String(token).trim();

        const up = t.toUpperCase();
        if ((SCC_MAPS.SOURCE_CURRENCIES || []).includes(up)) return up;

        if (typeof SCC_MAPS.getCodesForSymbol === "function") {
            const codes = SCC_MAPS.getCodesForSymbol(t);
            if (codes) return Array.isArray(codes) ? String(codes[0]).toUpperCase() : String(codes).toUpperCase();
        }

        const symMap = SCC_MAPS.SYMBOL_TO_CODES || {};
        const codes = symMap[t] || symMap[t.toLowerCase()] || null;
        if (Array.isArray(codes)) return String(codes[0]).toUpperCase();
        if (typeof codes === "string") return String(codes).toUpperCase();

        return null;
    }

    function buildTokenRegex() {
        const SCC_MAPS = globalThis.SCC_MAPS || {};
        const symbols = Object.keys(SCC_MAPS.SYMBOL_TO_CODES || {})
            .map(escapeRegex)
            .sort((a, b) => b.length - a.length)
            .join("|");

        const codes = (SCC_MAPS.CODE_TOKENS || []).join("|");
        const num = "([0-9][0-9.,\\s]{0,20})";

        return [
            new RegExp(`(${symbols})\\s*${num}`, "g"),
            new RegExp(`${num}\\s*(${symbols})`, "g"),
            new RegExp(`\\b(${codes})\\b\\s*${num}`, "gi"),
            new RegExp(`${num}\\s*\\b(${codes})\\b`, "gi")
        ];
    }

    function collectTextNodes(root, maxNodes) {
        const out = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (p.closest(`#${BAR_ID}`) || p.closest(`#${PICKER_HOST_ID}`)) return NodeFilter.FILTER_REJECT;
                if (p.closest(`[${ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
                if (p.closest(`[${ATTR_EL}="1"]`)) return NodeFilter.FILTER_REJECT;
                if (isEditableOrUnsafe(p)) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        while (walker.nextNode()) {
            out.push(walker.currentNode);
            if (out.length >= maxNodes) break;
        }
        return out;
    }

    function replaceMatchesInTextNode(textNode, fromCurrency, toCurrency, rate) {
        const original = textNode.nodeValue;
        const regs = buildTokenRegex();

        const matches = [];
        for (const re of regs) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(original)) !== null) {
                const g1 = m[1];
                const g2 = m[2];

                let token, numStr;
                if (normalizeTokenToCurrency(g1) && g2) { token = g1; numStr = g2; }
                else if (normalizeTokenToCurrency(g2) && g1) { token = g2; numStr = g1; }
                else continue;

                const cur = normalizeTokenToCurrency(token);
                if (!cur || cur !== fromCurrency) continue;

                const amount = parseAmount(numStr);
                if (!amount) continue;

                matches.push({
                    start: m.index,
                    end: m.index + m[0].length,
                    raw: m[0],
                    amount
                });
            }
        }

        if (matches.length === 0) return { replaced: 0 };

        matches.sort((a, b) => a.start - b.start || b.end - a.end);
        const nonOver = [];
        let lastEnd = -1;
        for (const mm of matches) {
            if (mm.start < lastEnd) continue;
            nonOver.push(mm);
            lastEnd = mm.end;
        }

        const frag = document.createDocumentFragment();
        let cursor = 0;
        let replaced = 0;

        for (const mm of nonOver) {
            if (mm.start > cursor) frag.append(document.createTextNode(original.slice(cursor, mm.start)));

            const converted = mm.amount * rate;
            const formatted = formatMoney(converted, toCurrency);

            const span = document.createElement("span");
            span.setAttribute(ATTR, "1");
            span.setAttribute(ATTR_ORIG, mm.raw);
            span.textContent = formatted;

            frag.append(span);
            replaced++;
            cursor = mm.end;
        }

        if (cursor < original.length) frag.append(document.createTextNode(original.slice(cursor)));

        textNode.parentNode.replaceChild(frag, textNode);
        return { replaced };
    }

    function tokensForCurrency(currency) {
        const SCC_MAPS = globalThis.SCC_MAPS || {};
        const out = new Set();
        const cur = String(currency || "").toUpperCase();
        if (!cur) return [];

        out.add(cur);

        for (const [sym, codes] of Object.entries(SCC_MAPS.SYMBOL_TO_CODES || {})) {
            const arr = Array.isArray(codes) ? codes.map(x => String(x).toUpperCase()) : [String(codes).toUpperCase()];
            if (arr.includes(cur)) out.add(sym);
        }

        for (const [k, v] of Object.entries(SCC_MAPS.TEXT_HINTS || {})) {
            const kl = String(k).toLowerCase();
            if (kl === "try") continue; // kritik false-positive
            if (String(v).toUpperCase() === cur) out.add(k);
        }

        const list = Array.from(out);
        list.sort((a, b) => b.length - a.length);
        return list;
    }

    function tokenPattern(token) {
        if (/^[A-Z]{3}$/.test(token)) return `\\b${token}\\b`;
        return escapeRegex(token);
    }

    function isLeafish(el) {
        if (!el) return false;
        if (el.childElementCount > 3) return false;
        if (el.querySelector("input,textarea,select,button,svg,canvas,img")) return false;
        return true;
    }

    function hasPriceKeyword(el) {
        const a =
            `${el.id || ""} ${el.className || ""} ${el.getAttribute("data-test-id") || ""} ` +
            `${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""}`.toLowerCase();
        return /(price|amount|total|cost|fare|rate|sum|payment|cena|koszt|platn|oplata)/i.test(a);
    }

    function convertElementFallback({ fromCurrency, toCurrency, rate, roots }) {
        const toks = tokensForCurrency(fromCurrency);
        if (!toks.length) return { count: 0 };

        const tokAlt = toks.map(tokenPattern).join("|");
        const num = "([0-9][0-9.,\\s]{0,20})";

        const reAmtTok = new RegExp(`${num}\\s*(${tokAlt})`, "i");
        const reTokAmt = new RegExp(`(${tokAlt})\\s*${num}`, "i");
        const reHasTok = new RegExp(tokAlt, "i");

        let count = 0;
        let budget = 6000;

        const walkerForRoot = (root) =>
            document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
                acceptNode(node) {
                    const el = node;
                    if (!(el instanceof Element)) return NodeFilter.FILTER_REJECT;
                    if (budget-- <= 0) return NodeFilter.FILTER_REJECT;
                    if (el.closest(`#${BAR_ID}`) || el.closest(`#${PICKER_HOST_ID}`)) return NodeFilter.FILTER_REJECT;
                    if (el.closest(`[${ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
                    if (el.closest(`[${ATTR_EL}="1"]`)) return NodeFilter.FILTER_REJECT;
                    if (isEditableOrUnsafe(el)) return NodeFilter.FILTER_REJECT;
                    if (!isLeafish(el)) return NodeFilter.FILTER_SKIP;

                    const text = (el.textContent || "").trim();
                    if (!text) return NodeFilter.FILTER_SKIP;
                    if (text.length < 3 || text.length > 140) return NodeFilter.FILTER_SKIP;
                    if (!/\d/.test(text)) return NodeFilter.FILTER_SKIP;

                    const hasTok = reHasTok.test(text);
                    if (!hasTok && !hasPriceKeyword(el)) return NodeFilter.FILTER_SKIP;

                    return NodeFilter.FILTER_ACCEPT;
                }
            });

        for (const root of roots) {
            const w = walkerForRoot(root);
            while (w.nextNode()) {
                const el = w.currentNode;

                if (el.querySelector(`span[${ATTR}="1"], [${ATTR_EL}="1"]`)) continue;

                const text0 = (el.textContent || "").trim();
                if (!text0) continue;

                let replaced = false;
                let newText = text0;

                newText = newText.replace(reAmtTok, (full, amtStr) => {
                    const amt = parseAmount(amtStr);
                    if (!amt) return full;
                    replaced = true;
                    return formatMoney(amt * rate, toCurrency);
                });

                if (!replaced) {
                    newText = text0.replace(reTokAmt, (full, _t, amtStr) => {
                        const amt = parseAmount(amtStr);
                        if (!amt) return full;
                        replaced = true;
                        return formatMoney(amt * rate, toCurrency);
                    });
                }

                if (!replaced || newText === text0) continue;

                if (!EL_ORIG_HTML.has(el)) EL_ORIG_HTML.set(el, el.innerHTML);
                el.setAttribute(ATTR_EL, "1");
                el.textContent = newText;
                count++;
            }
        }

        return { count };
    }

    function computeRoots(selectors) {
        let roots = [document.body || document.documentElement];

        if (Array.isArray(selectors) && selectors.length) {
            const set = new Set();
            for (const sel of selectors) {
                try { document.querySelectorAll(sel).forEach(el => set.add(el)); } catch {}
            }
            if (set.size) roots = Array.from(set);
        }

        return roots;
    }

    function convert({ fromCurrency, toCurrency, rate, selectors }) {
        if (!fromCurrency || !toCurrency || !rate) return { count: 0 };
        if (toCurrency === "ORIGINAL") return { count: 0 };

        const roots = computeRoots(selectors);

        let total = 0;

        for (const root of roots) {
            const nodes = collectTextNodes(root, 8000);
            for (const n of nodes) {
                const r = replaceMatchesInTextNode(n, fromCurrency, toCurrency, rate);
                total += r.replaced;
            }
        }

        const fb = convertElementFallback({ fromCurrency, toCurrency, rate, roots });
        total += fb.count;

        return { count: total };
    }

    function revert() {
        const spans = Array.from(document.querySelectorAll(`span[${ATTR}="1"][${ATTR_ORIG}]`));
        let count = 0;

        for (const sp of spans) {
            const orig = sp.getAttribute(ATTR_ORIG);
            if (!orig) continue;
            sp.replaceWith(document.createTextNode(orig));
            count++;
        }

        const els = Array.from(document.querySelectorAll(`[${ATTR_EL}="1"]`));
        for (const el of els) {
            const orig = EL_ORIG_HTML.get(el);
            if (typeof orig === "string") el.innerHTML = orig;
            el.removeAttribute(ATTR_EL);
            count++;
        }

        return { count };
    }

    globalThis.SCCConvert = { convert, revert };
})();
