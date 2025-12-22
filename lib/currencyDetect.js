// lib/currencyDetect.js
(() => {
    function safeHostFromUrl(url) {
        try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
    }

    function deepFindPriceCurrency(node) {
        if (!node) return null;
        if (typeof node === "object") {
            if (typeof node.priceCurrency === "string") return node.priceCurrency.trim().toUpperCase();
            if (Array.isArray(node)) {
                for (const it of node) {
                    const r = deepFindPriceCurrency(it);
                    if (r) return r;
                }
            } else {
                for (const k of Object.keys(node)) {
                    const r = deepFindPriceCurrency(node[k]);
                    if (r) return r;
                }
            }
        }
        return null;
    }

    function findStructuredCurrency(doc) {
        const SCC_MAPS = globalThis.SCC_MAPS || {};

        const micro = doc.querySelector('[itemprop="priceCurrency"]');
        if (micro) {
            const val = (micro.getAttribute("content") || micro.textContent || "").trim().toUpperCase();
            if ((SCC_MAPS.SOURCE_CURRENCIES || []).includes(val)) {
                return { currency: val, confidence: 0.95, evidence: "microdata:itemprop=priceCurrency" };
            }
        }

        const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 25);
        for (const s of scripts) {
            const txt = (s.textContent || "").trim();
            if (!txt) continue;
            try {
                const json = JSON.parse(txt);
                const hit = deepFindPriceCurrency(json);
                if (hit && (SCC_MAPS.SOURCE_CURRENCIES || []).includes(hit)) {
                    return { currency: hit, confidence: 0.9, evidence: "jsonld:priceCurrency" };
                }
            } catch {}
        }

        const dataEl = doc.querySelector('[data-currency],[data-price-currency],[data-pricecurrency]');
        if (dataEl) {
            const v = (dataEl.getAttribute("data-currency") ||
                dataEl.getAttribute("data-price-currency") ||
                dataEl.getAttribute("data-pricecurrency") || "").trim().toUpperCase();
            if ((SCC_MAPS.SOURCE_CURRENCIES || []).includes(v)) {
                return { currency: v, confidence: 0.8, evidence: "data-attr:currency" };
            }
        }

        return null;
    }

    function tldHintCurrency(host) {
        const SCC_MAPS = globalThis.SCC_MAPS || {};
        const parts = (host || "").split(".");
        if (parts.length < 2) return null;
        const tld = parts[parts.length - 1].toLowerCase();
        const c = (SCC_MAPS.TLD_TO_CURRENCY || {})[tld];
        return c ? { currency: c, confidence: 0.35, evidence: `tld:${tld}` } : null;
    }

    // ---- helpers (digit-near) ----
    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    const _nearCache = new Map();

    function getNearRegex(tokenPattern, maxGap) {
        const key = `${maxGap}::${tokenPattern}`;
        let re = _nearCache.get(key);
        if (re) return re;
        re = new RegExp(`\\d[^\\d]{0,${maxGap}}${tokenPattern}|${tokenPattern}[^\\d]{0,${maxGap}}\\d`, "i");
        _nearCache.set(key, re);
        return re;
    }

    function hasDigitNearToken(text, tokenLiteral, maxGap = 10) {
        if (!text || !tokenLiteral) return false;
        const tok = escapeRegex(tokenLiteral);
        return getNearRegex(tok, maxGap).test(text);
    }

    function hasDigitNearIsoCode(text, code, maxGap = 12) {
        if (!text || !code) return false;
        const tok = `\\b${escapeRegex(code)}\\b`;
        return getNearRegex(tok, maxGap).test(text);
    }

    function pickContextText(node, maxLen = 800) {
        const t0 = (node?.nodeValue || "");
        const p = node?.parentElement || null;
        const gp = p?.parentElement || null;

        const cand = [];
        if (t0) cand.push({ el: p, text: t0 });
        if (p && p.textContent) cand.push({ el: p, text: p.textContent });
        if (gp && gp.textContent) cand.push({ el: gp, text: gp.textContent });

        for (const c of cand) {
            const s = (c.text || "").trim();
            if (!s) continue;
            if (s.length > maxLen) continue;
            if (!/\d/.test(s)) continue;
            return { ctxEl: c.el, ctxText: s };
        }

        return { ctxEl: p, ctxText: (t0 || "").trim() };
    }

    function hasPriceContext(el) {
        if (!el || !(el instanceof Element)) return false;
        const a =
            `${el.id || ""} ${el.className || ""} ${el.getAttribute("data-test-id") || ""} ` +
            `${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""} ` +
            `${Array.from(el.attributes || []).map(x => x.name).join(" ")}`.toLowerCase();

        if (/(price|amount|total|cost|fare|rate|sum|payment|pay|from|cena|koszt|platn|oplata)/i.test(a)) return true;
        if (el.matches?.('[itemprop="price"],[itemprop="priceCurrency"],meta[property*="price" i],meta[name*="price" i]')) return true;
        if (el.closest?.('[itemprop="price"],[data-price],[data-amount],[data-total],[data-currency],[data-price-currency]')) return true;
        return false;
    }

    function scanTextForCurrency(doc) {
        const SCC_MAPS = globalThis.SCC_MAPS || {};

        const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                const tag = p.tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "INPUT") {
                    return NodeFilter.FILTER_REJECT;
                }
                if (p.closest("#scc-bar-host")) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const counts = new Map();

        const latinHints = [];
        const nonLatinHints = [];

        for (const [kRaw, codeRaw] of Object.entries(SCC_MAPS.TEXT_HINTS || {})) {
            const k = String(kRaw);
            const kl = k.toLowerCase();
            const code = String(codeRaw || "").toUpperCase();

            if (!code) continue;
            if (kl === "try") continue; // kritik false-positive

            if (/^[a-z]{2,5}$/i.test(k)) {
                try {
                    const re = (kl === "tl")
                        ? new RegExp(`(?<![a-zA-Z])${k}(?![a-zA-Z])`, "i")
                        : new RegExp(`\\b${k}\\b`, "i");
                    latinHints.push({ key: k, re, code });
                } catch {}
            } else {
                nonLatinHints.push({ key: kl, code });
            }
        }

        let seen = 0;
        while (walker.nextNode() && seen < 800) {
            seen++;

            const node = walker.currentNode;
            const { ctxEl, ctxText } = pickContextText(node, 900);
            if (!ctxText) continue;

            // 1) symbols (digit-near)
            for (const sym of Object.keys(SCC_MAPS.SYMBOL_TO_CODES || {})) {
                if (!ctxText.includes(sym)) continue;
                if (!hasDigitNearToken(ctxText, sym, 12)) continue;

                const codes = (SCC_MAPS.SYMBOL_TO_CODES || {})[sym];
                const first = Array.isArray(codes) ? codes[0] : codes;
                const cur = String(first || "").toUpperCase();
                if (!cur) continue;

                const w = Array.isArray(codes) && codes.length > 1 ? 2 : 5;
                counts.set(cur, (counts.get(cur) || 0) + w);
            }

            // 2) ISO codes (digit-near)
            for (const code of (SCC_MAPS.CODE_TOKENS || [])) {
                if (!hasDigitNearIsoCode(ctxText, code, 14)) continue;
                counts.set(code, (counts.get(code) || 0) + 6);
            }

            // 3) TEXT_HINTS (digit-near + mümkünse price-context)
            const pc = hasPriceContext(ctxEl) ? 1 : 0;

            for (const h of latinHints) {
                if (!h.re.test(ctxText)) continue;
                if (!hasDigitNearToken(ctxText, h.key, 10)) continue;
                counts.set(h.code, (counts.get(h.code) || 0) + (pc ? 2 : 1));
            }

            const lower = ctxText.toLowerCase();
            for (const h of nonLatinHints) {
                if (!lower.includes(h.key)) continue;
                if (!hasDigitNearToken(lower, h.key, 10)) continue;
                counts.set(h.code, (counts.get(h.code) || 0) + (pc ? 2 : 1));
            }
        }

        let best = null;
        let bestScore = 0;
        for (const [cur, sc] of counts.entries()) {
            if (sc > bestScore) { bestScore = sc; best = cur; }
        }
        if (!best) return null;

        const conf = Math.min(0.78, 0.25 + bestScore * 0.035);
        return { currency: best, confidence: conf, evidence: "text-scan:ctx-digit-near" };
    }

    async function detectPageCurrency(doc, url, settings) {
        const SCC_MAPS = globalThis.SCC_MAPS || {};
        const host = safeHostFromUrl(url);

        const ov = settings?.domainCurrencyOverride?.[host];
        if (ov && (SCC_MAPS.SOURCE_CURRENCIES || []).includes(ov)) {
            return { currency: ov, confidence: 1.0, evidence: "override" };
        }

        const structured = findStructuredCurrency(doc);
        if (structured) return structured;

        const scan = scanTextForCurrency(doc);
        const tld = tldHintCurrency(host);

        if (scan) return scan;
        if (tld) return tld;

        return { currency: null, confidence: 0, evidence: "none" };
    }

    globalThis.SCCDetect = { detectPageCurrency };
})();
