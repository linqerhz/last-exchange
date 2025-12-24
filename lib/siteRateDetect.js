// lib/siteRateDetect.js
// V1: dual-price (aynı "price group" içinde 2 farklı currency + 2 sayı) -> oran çıkarır.
// V2: base-quote widget (baseCode verildiyse) -> "USD 84.5 | EUR 100.25" gibi bloklardan QUOTE<->BASE çıkarır.
//
// Çıktı: { "EUR->USD": {...}, "USD->RUB": {...}, "RUB->USD": {...}, ... }
//
// Bağımlılıklar:
// - globalThis.SCC_MAPS (currencyMaps.js)

(() => {
    // ✅ ADIM 1.1 debug helper
    function sccDbg(...a) {
        if (globalThis.SCC_DEBUG) console.log("[SCC]", ...a);
    }

    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function nowMs() {
        return (globalThis.performance && typeof performance.now === "function")
            ? performance.now()
            : Date.now();
    }

    function parseNumberSmart(raw) {
        const parser = globalThis.SCCNumber?.parseNumberSmart;
        return typeof parser === "function" ? parser(raw) : null;
    }

    function median(arr) {
        const a = arr.slice().sort((x, y) => x - y);
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    function relDispersionMAD(values) {
        // ✅ tek sample varsa dispersion 0 say (yoksa conf gereksiz düşüyor)
        if (values.length < 2) return 0;
        const med = median(values);
        const devs = values.map(v => Math.abs(v - med));
        const mad = median(devs);
        return med !== 0 ? (mad / Math.abs(med)) : 0;
    }

    function hasStrikeContext(el) {
        if (!el || !(el instanceof Element)) return false;
        if (el.closest && el.closest("s,del")) return true;
        const cls = (el.className || "").toString().toLowerCase();
        const id = (el.id || "").toString().toLowerCase();
        return /(old|was|strike|strikethrough|discount|previous|prev|before|eski|önce)/.test(cls + " " + id);
    }

    function normalizeTokenToCurrency(token) {
        if (!token) return null;
        const SCC_MAPS = globalThis.SCC_MAPS || {};

        // 1) symbol map (helper varsa onu kullan)
        let codes = null;
        if (typeof SCC_MAPS.getCodesForSymbol === "function") {
            codes = SCC_MAPS.getCodesForSymbol(token);
        } else {
            const symMap = SCC_MAPS.SYMBOL_TO_CODES || {};
            codes = symMap[token] || symMap[String(token).toLowerCase().trim()] || null;
        }

        const ambiguous = typeof SCC_MAPS.isAmbiguousSymbol === "function"
            ? SCC_MAPS.isAmbiguousSymbol(token)
            : (Array.isArray(codes) && codes.length > 1);

        if (codes) {
            const arr = Array.isArray(codes) ? codes : [codes];
            const code = arr[0];
            if (code) return { code: String(code).toUpperCase(), ambiguous: !!ambiguous };
        }

        // 2) ISO code token (EUR, USD...)
        const up = String(token).trim().toUpperCase();
        if ((SCC_MAPS.SOURCE_CURRENCIES || []).includes(up)) {
            return { code: up, ambiguous: false };
        }

        return null;
    }

    function buildRegexes() {
        const SCC_MAPS = globalThis.SCC_MAPS || {};

        const symKeys = Object.keys(SCC_MAPS.SYMBOL_TO_CODES || {});
        const codeKeys = (SCC_MAPS.CODE_TOKENS || []).slice();

        const tokens = [...new Set([...symKeys, ...codeKeys])]
            .filter(Boolean)
            .map(String)
            .sort((a, b) => b.length - a.length);

        const tokAlt = tokens.map(escapeRegExp).join("|");
        const num = "([0-9][0-9\\s.,]{0,20})";

        const reTokNum = new RegExp(`(${tokAlt})\\s*${num}`, "gi");
        const reNumTok = new RegExp(`${num}\\s*(${tokAlt})`, "gi");

        // token var mı? (global değil!)
        const reAnyTok = new RegExp(`(${tokAlt})`, "i");

        // icon/attr içinde ISO kod arama
        const iconAlt = codeKeys.length ? codeKeys.map(escapeRegExp).join("|") : "USD|EUR|TRY|RUB";
        const reIconCode = new RegExp(`\\b(${iconAlt})\\b`, "i");

        return { reTokNum, reNumTok, reAnyTok, reIconCode };
    }

    function collectCurNumsFromText(text, reTokNum, reNumTok, limit = 10) {
        const out = [];
        if (!text) return out;

        let m;

        reTokNum.lastIndex = 0;
        while ((m = reTokNum.exec(text)) !== null) {
            const tok = m[1];
            const numStr = m[2];
            const cur = normalizeTokenToCurrency(tok);
            const val = parseNumberSmart(numStr);
            if (cur && val != null) out.push({ cur: cur.code, val, ambiguous: !!cur.ambiguous });
            if (out.length >= limit) return out;
        }

        reNumTok.lastIndex = 0;
        while ((m = reNumTok.exec(text)) !== null) {
            const numStr = m[1];
            const tok = m[2];
            const cur = normalizeTokenToCurrency(tok);
            const val = parseNumberSmart(numStr);
            if (cur && val != null) out.push({ cur: cur.code, val, ambiguous: !!cur.ambiguous });
            if (out.length >= limit) return out;
        }

        return out;
    }

    function collectFromIcons(group, reIconCode) {
        const out = [];
        if (!group || !group.querySelectorAll) return out;

        const nodes = group.querySelectorAll('img[alt],img[title],[aria-label],[title]');
        let scanned = 0;

        for (const node of nodes) {
            if (++scanned > 20) break;
            if (hasStrikeContext(node)) continue;

            const alt = (node.getAttribute && (node.getAttribute("alt") || node.getAttribute("aria-label") || node.getAttribute("title"))) || "";
            const title = (node.getAttribute && node.getAttribute("title")) || "";
            const src = (node.getAttribute && (node.getAttribute("src") || node.getAttribute("srcset"))) || "";
            const blob = `${alt} ${title} ${src}`;

            const m = blob.match(reIconCode);
            if (!m) continue;

            const cur = String(m[1]).toUpperCase();
            if (!cur) continue;

            // sayı: önce parent text, sonra sibling text
            let numText = "";
            const p = node.parentElement;
            if (p && !hasStrikeContext(p)) numText = (p.innerText || p.textContent || "").trim();

            if (!/\d/.test(numText)) {
                let sib = node.nextElementSibling, hops = 0;
                while (sib && hops++ < 3) {
                    if (!hasStrikeContext(sib)) {
                        const t = (sib.innerText || sib.textContent || "").trim();
                        if (/\d/.test(t)) { numText = t; break; }
                    }
                    sib = sib.nextElementSibling;
                }
            }

            if (!/\d/.test(numText)) {
                let sib = node.previousElementSibling, hops = 0;
                while (sib && hops++ < 3) {
                    if (!hasStrikeContext(sib)) {
                        const t = (sib.innerText || sib.textContent || "").trim();
                        if (/\d/.test(t)) { numText = t; break; }
                    }
                    sib = sib.previousElementSibling;
                }
            }

            const nm = numText.match(/[-+]?\d[\d\s.,]*\d|[-+]?\d/g);
            if (!nm) continue;

            const val = parseNumberSmart(nm[0]);
            if (val != null) out.push({ cur, val, ambiguous: false });
            if (out.length >= 4) break;
        }

        return out;
    }

    // -----------------------------------------
    // ✅ rateSelectorsByHost (USD/EUR) -> DOM'dan deterministik rate çıkar
    // -----------------------------------------
    function normHost(host) {
        const fn = globalThis.SCCStorage?.normHost;
        if (typeof fn === "function") return fn(host);
        return String(host || "").trim().toLowerCase().replace(/^www\./, "");
    }

    function getRateSelectorEntry(settings, host) {
        host = normHost(host);
        const e = settings?.rateSelectorsByHost?.[host] || null;
        return {
            USD: e?.USD ? String(e.USD).trim() : null,
            EUR: e?.EUR ? String(e.EUR).trim() : null,
        };
    }

    function quoteTokenRe(code) {
        const c = String(code || "").trim().toUpperCase();
        if (c === "USD") return /(\bUSD\b|\$)/i;
        if (c === "EUR") return /(\bEUR\b|€)/i;
        return new RegExp(`\\b${escapeRegExp(c)}\\b`, "i");
    }

    function baseTokenRe(code) {
        const c = String(code || "").trim().toUpperCase();
        if (!c) return null;
        return new RegExp(`\\b${escapeRegExp(c)}\\b`, "i");
    }

    // ✅ ADIM 1.3 helpers
    function sliceText(s, n = 260) {
        const t = String(s || "").replace(/\u00A0/g, " ").trim();
        return t.length > n ? t.slice(0, n) : t;
    }

    function collectCandidateTexts(el) {
        const out = [];
        if (!el || !(el instanceof Element)) return out;

        // 1) self
        out.push(sliceText(el.innerText || el.textContent || ""));

        // 2) small children
        try {
            const kids = el.querySelectorAll("span,div,strong,em");
            for (let i = 0; i < kids.length && i < 12; i++) {
                out.push(sliceText(kids[i].innerText || kids[i].textContent || ""));
            }
        } catch { }

        // 3) parents (2 hop)
        let p = el.parentElement;
        for (let i = 0; i < 2 && p; i++) {
            out.push(sliceText(p.innerText || p.textContent || ""));
            p = p.parentElement;
        }

        // 4) siblings (2 hop)
        let nx = el.nextElementSibling;
        for (let i = 0; i < 2 && nx; i++) {
            out.push(sliceText(nx.innerText || nx.textContent || ""));
            nx = nx.nextElementSibling;
        }
        let pv = el.previousElementSibling;
        for (let i = 0; i < 2 && pv; i++) {
            out.push(sliceText(pv.innerText || pv.textContent || ""));
            pv = pv.previousElementSibling;
        }

        // 5) big container LAST
        const big = el.closest?.("footer,section,article,div");
        if (big && big !== el) out.push(sliceText(big.innerText || big.textContent || "", 320));

        return Array.from(new Set(out)).filter(t => t && t.length >= 3);
    }

    // ✅ ADIM 1.3: daha toleranslı "ratey" kontrol (selector'ın number-only node'unda null'ı azaltır)
    function looksRatey(text, quoteCode) {
        if (!text) return false;
        const t = String(text);
        if (!/\d/.test(t)) return false;

        const q = String(quoteCode || "").trim().toUpperCase();
        const qt = q ? quoteTokenRe(q) : null;
        const hasQuoteToken = qt ? qt.test(t) : false;

        // genel hint'ler (token şartı yok)
        const hasHints = /(=|rate|exchange|currency|kurs|kur|doviz|курс|валют|руб|eur|usd)/i.test(t);

        // quote token + sayı  OR  hint + sayı
        return hasQuoteToken || hasHints;
    }

    function extractRateNumberFromText(rawText, quoteCode, baseCode) {
        if (rawText == null) return null;
        const text = String(rawText).replace(/\u00A0/g, " ").trim();
        if (!text) return null;

        // 1) "1 USD = 83.5 RUB" -> "=" sonrası ilk sayı
        const eqPos = text.indexOf("=");
        if (eqPos >= 0) {
            const right = text.slice(eqPos + 1);
            const m = right.match(/[-+]?\d[\d\s.,]*\d|[-+]?\d/g);
            if (m && m[0]) return parseNumberSmart(m[0]);
        }

        // 2) "USD 84.5" / "$ 84.5" / "84.5 USD"
        const qt = quoteTokenRe(quoteCode);
        const numRe = /[-+]?\d[\d\s.,]*\d|[-+]?\d/g;

        // quote -> number
        {
            const m = text.match(new RegExp(`${qt.source}\\s*[:\\-–—]?\\s*(${numRe.source})`, "i"));
            if (m && m[1]) {
                const v = parseNumberSmart(m[1]);
                if (v != null) return v;
            }
        }

        // number -> quote
        {
            const m = text.match(new RegExp(`(${numRe.source})\\s*${qt.source}`, "i"));
            if (m && m[1]) {
                const v = parseNumberSmart(m[1]);
                if (v != null) return v;
            }
        }

        // 3) fallback: (güvenlik) quote/base token yoksa "rastgele son sayı" alma
        const bt = baseTokenRe(baseCode);
        const hasQuote = qt.test(text);
        const hasBase = bt ? bt.test(text) : false;
        if (!hasQuote && !hasBase) return null;

        const all = text.match(numRe);
        if (!all || !all.length) return null;
        return parseNumberSmart(all[all.length - 1]);
    }

    // ✅ ADIM 1.4: readRateFromSelector ROBUST + debug log (meta)
    function readRateFromSelector(doc, selector, meta = {}) {
        if (!doc || !selector) return null;

        let nodes = [];
        try { nodes = Array.from(doc.querySelectorAll(selector)); } catch { return null; }
        if (!nodes.length) return null;

        const host = meta.host || "";
        const quote = (meta.quote || "").toUpperCase() || "UNK";
        const base = (meta.base || "").toUpperCase() || "";
        const allowNumericOnly = !!meta.explicitSelector;

        let candidatesChecked = 0;
        let rateyChecked = 0;
        let numericChecked = 0;
        let lastFailReason = "";
        let lastFailSample = "";

        const maxNodes = 8;
        for (let i = 0; i < nodes.length && i < maxNodes; i++) {
            const el = nodes[i];
            if (!el || !(el instanceof Element)) continue;

            // kendi UI’miz değil
            if (el.closest && (el.closest("#scc-bar-host") || el.closest("#scc-picker-host"))) continue;

            const candidates = collectCandidateTexts(el);

            for (const txt of candidates) {
                candidatesChecked++;
                if (!looksRatey(txt, quote)) {
                    if (allowNumericOnly && /\d/.test(String(txt))) numericChecked++;
                    lastFailReason = "no_ratey_hint";
                    lastFailSample = txt;
                    continue;
                }
                rateyChecked++;

                const v = extractRateNumberFromText(txt, quote, base);
                if (v == null) {
                    lastFailReason = "no_parseable_number";
                    lastFailSample = txt;
                    continue;
                }

                // sanity
                if (!(v > 0.000001 && v < 200000)) {
                    lastFailReason = "out_of_range";
                    lastFailSample = txt;
                    continue;
                }

                sccDbg(`[rateSel] host=${host} quote=${quote} base=${base} sel="${selector}" matches=${nodes.length} picked="${sliceText(txt, 180)}" rate=${v}`);
                return v;
            }

            if (allowNumericOnly) {
                for (const txt of candidates) {
                    if (!/\d/.test(String(txt))) continue;
                    const m = String(txt).match(/[-+]?\d[\d\s.,]*\d|[-+]?\d/g);
                    if (!m || !m[0]) continue;
                    const v = parseNumberSmart(m[0]);
                    if (!(v > 0.000001 && v < 200000)) continue;
                    sccDbg(`[rateSel] host=${host} quote=${quote} base=${base} sel="${selector}" matches=${nodes.length} fallback_numeric="${sliceText(txt, 180)}" rate=${v}`);
                    return v;
                }
                lastFailReason = lastFailReason || "numeric_only_no_match";
                lastFailSample = lastFailSample || candidates[0] || "";
            }
        }
        sccDbg(`[rateSel] host=${host} quote=${quote} base=${base} sel="${selector}" matches=${nodes.length} FAIL reason=${lastFailReason || "unknown"} sample="${sliceText(lastFailSample, 180)}" candidates=${candidatesChecked} ratey=${rateyChecked} numeric=${numericChecked} allowNumericOnly=${allowNumericOnly}`);
        return null;
    }

    function inferFromRateSelectors(doc, host, settings, baseCode, memo) {
        if (!baseCode) {
            const override = settings?.domainCurrencyOverride?.[host];
            if (override) baseCode = String(override).trim().toUpperCase();
        }
        if (!baseCode) return null;

        const entry = getRateSelectorEntry(settings, host);
        if (!entry.USD && !entry.EUR) return null;

        const base = String(baseCode).trim().toUpperCase();
        sccDbg("[rateSel] loaded for host", { host, base, selectors: entry });
        const out = {};
        const ts = Date.now();

        const mk = (rate) => ({
            rate,
            confidence: 0.95,
            evidence: "rate-selector",
            nSamples: 3,
            dispersion: 0,
            ts,
            ambiguous: false
        });

        const put = (quote, v) => {
            if (!(v > 0) || !Number.isFinite(v)) return;
            const q = String(quote).trim().toUpperCase();
            out[`${q}->${base}`] = mk(v);

            const inv = 1 / v;
            if (Number.isFinite(inv) && inv > 0) out[`${base}->${q}`] = mk(inv);
        };

        if (entry.USD) {
            const key = `USD|${base}|${entry.USD}`;
            let v = memo?.get?.(key);
            if (v === undefined) {
                v = readRateFromSelector(doc, entry.USD, { host, quote: "USD", base, explicitSelector: true });
                memo?.set?.(key, v);
            }
            if (v != null) put("USD", v);
        }
        if (entry.EUR) {
            const key = `EUR|${base}|${entry.EUR}`;
            let v = memo?.get?.(key);
            if (v === undefined) {
                v = readRateFromSelector(doc, entry.EUR, { host, quote: "EUR", base, explicitSelector: true });
                memo?.set?.(key, v);
            }
            if (v != null) put("EUR", v);
        }

        return Object.keys(out).length ? out : null;
    }

    // ✅ ADIM 1.2: computeRoots(forRates) + host normalize
    function computeRoots(doc, host, settings, selectorsOverride, forRates = false) {
        host = normHost(host);

        // ✅ rates detect için: scope’a kilitlenme, body mutlaka taransın
        if (forRates) {
            return [doc.body || doc.documentElement];
        }

        const sels = Array.isArray(selectorsOverride)
            ? selectorsOverride
            : (settings?.customSelectorsByHost?.[host] || []);

        if (Array.isArray(sels) && sels.length) {
            const set = new Set();
            for (const sel of sels) {
                try { doc.querySelectorAll(sel).forEach(el => set.add(el)); } catch { }
            }
            if (set.size) return Array.from(set);
        }

        return [doc.body || doc.documentElement];
    }

    function chooseGroup(el, root) {
        let cur = el;
        for (let i = 0; i < 5 && cur && cur !== root; i++) {
            const tag = (cur.tagName || "").toLowerCase();
            if (tag === "li" || tag === "tr" || tag === "article" || tag === "section") return cur;
            cur = cur.parentElement;
        }
        return el.parentElement || el;
    }

    function ctxHint(el) {
        if (!el || !(el instanceof Element)) return "";
        const attrs = [];
        for (const a of (el.attributes || [])) attrs.push(a.name);
        const blob =
            `${el.id || ""} ${el.className || ""} ${el.getAttribute?.("aria-label") || ""} ` +
            `${el.getAttribute?.("data-testid") || ""} ${el.getAttribute?.("data-test-id") || ""} ` +
            `${attrs.join(" ")}`.toLowerCase();
        return blob;
    }

    function isLikelyRateWidget(group, gText, distinctCurs) {
        const hint = ctxHint(group) + " " + ctxHint(group?.parentElement);

        const hasRateWords = /(exchange|currency|currencies|rate|fx|kurs|kur|doviz|валют|курс)/i.test(hint + " " + gText);
        const hasPriceWords = /(total|from|per|night|nights|adult|child|room|person|price|booking|tax|fees|итого|стоим|ноч|чел|номер|за\s+\d+)/i.test(gText);

        const shortish = (gText || "").length <= 140;
        const hasSep = /[|•]/.test(gText);

        if (hasRateWords) return true;
        if (shortish && hasSep && distinctCurs >= 2 && !hasPriceWords) return true;

        return false;
    }

    function inferFromDualPrice(roots, opts) {
        const { reTokNum, reNumTok, reAnyTok, reIconCode } = buildRegexes();

        const samples = {};
        const start = nowMs();

        const maxEls = Number.isFinite(opts?.maxEls) ? opts.maxEls : 2200;
        const maxGroups = Number.isFinite(opts?.maxGroups) ? opts.maxGroups : 400;
        const budgetMs = Number.isFinite(opts?.budgetMs) ? opts.budgetMs : 28;

        let walked = 0;
        let groupsUsed = 0;
        const seenGroups = new WeakSet();

        for (const root of roots) {
            if (!root) continue;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
                walked++;
                if (walked > maxEls) return samples;
                if ((nowMs() - start) > budgetMs) return samples;
                if (groupsUsed >= maxGroups) return samples;

                const el = walker.currentNode;
                if (!(el instanceof Element)) continue;

                if (el.closest && (el.closest("#scc-bar-host") || el.closest("#scc-picker-host"))) continue;
                if (hasStrikeContext(el)) continue;

                const txt = (el.textContent || "").replace(/\u00A0/g, " ").trim();
                if (!txt) continue;
                if (txt.length > 220) continue;

                const hasDigit = /\d/.test(txt);
                const hasTok = reAnyTok.test(txt);
                if (!hasDigit && !hasTok) continue;

                const group = chooseGroup(el, root);
                if (!group || seenGroups.has(group)) continue;
                seenGroups.add(group);

                if (hasStrikeContext(group)) continue;

                const gText = (group.innerText || group.textContent || "").replace(/\u00A0/g, " ").trim();
                if (!gText || gText.length > 900) continue;

                const curNumsText = collectCurNumsFromText(gText, reTokNum, reNumTok, 12);
                const curNumsIcon = collectFromIcons(group, reIconCode);
                const curNums = curNumsText.concat(curNumsIcon);

                if (curNums.length < 2) continue;

                const byCur = {};
                let ambAny = false;
                for (const x of curNums) {
                    if (!x.cur || !x.val) continue;
                    (byCur[x.cur] ||= []).push(x.val);
                    if (x.ambiguous) ambAny = true;
                }

                const curs = Object.keys(byCur);
                if (curs.length < 2) continue;

                const valByCur = {};
                for (const c of curs) valByCur[c] = median(byCur[c]);

                for (let i = 0; i < curs.length; i++) {
                    for (let j = 0; j < curs.length; j++) {
                        if (i === j) continue;
                        const a = curs[i], b = curs[j];
                        const va = valByCur[a], vb = valByCur[b];
                        if (!(va > 0 && vb > 0)) continue;

                        const rate = vb / va; // 1 a = rate b
                        if (!Number.isFinite(rate) || rate <= 0 || rate >= 1e8) continue;

                        const k = `${a}->${b}`;
                        (samples[k] ||= { rates: [], ambCount: 0, evidence: "dual-price" }).rates.push(rate);
                        if (ambAny) samples[k].ambCount++;
                    }
                }

                groupsUsed++;
            }
        }

        return samples;
    }

    function inferAgainstBase(roots, baseCode, opts) {
        const { reTokNum, reNumTok, reAnyTok, reIconCode } = buildRegexes();

        const samples = {};
        const start = nowMs();

        const maxEls = Number.isFinite(opts?.maxEls) ? opts.maxEls : 2200;
        const maxGroups = Number.isFinite(opts?.maxGroups) ? opts.maxGroups : 400;
        const budgetMs = Number.isFinite(opts?.budgetMs) ? opts.budgetMs : 28;

        let walked = 0;
        let groupsUsed = 0;
        const seenGroups = new WeakSet();

        for (const root of roots) {
            if (!root) continue;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
                walked++;
                if (walked > maxEls) return samples;
                if ((nowMs() - start) > budgetMs) return samples;
                if (groupsUsed >= maxGroups) return samples;

                const el = walker.currentNode;
                if (!(el instanceof Element)) continue;

                if (el.closest && (el.closest("#scc-bar-host") || el.closest("#scc-picker-host"))) continue;
                if (hasStrikeContext(el)) continue;

                const txt = (el.textContent || "").replace(/\u00A0/g, " ").trim();
                if (!txt) continue;
                if (txt.length > 220) continue;

                const hasDigit = /\d/.test(txt);
                const hasTok = reAnyTok.test(txt);
                if (!hasDigit && !hasTok) continue;

                const group = chooseGroup(el, root);
                if (!group || seenGroups.has(group)) continue;
                seenGroups.add(group);

                if (hasStrikeContext(group)) continue;

                const gText = (group.innerText || group.textContent || "").replace(/\u00A0/g, " ").trim();
                if (!gText || gText.length > 900) continue;

                const curNumsText = collectCurNumsFromText(gText, reTokNum, reNumTok, 12);
                const curNumsIcon = collectFromIcons(group, reIconCode);
                const curNums = curNumsText.concat(curNumsIcon);

                if (curNums.length < 2) continue;

                const byCur = {};
                let ambAny = false;
                for (const x of curNums) {
                    if (!x.cur || !x.val) continue;
                    if (x.cur === baseCode) continue;
                    (byCur[x.cur] ||= []).push(x.val);
                    if (x.ambiguous) ambAny = true;
                }

                const quotes = Object.keys(byCur);
                if (quotes.length < 2) continue;

                if (!isLikelyRateWidget(group, gText, quotes.length)) continue;

                for (const q of quotes) {
                    const v = median(byCur[q]);
                    if (!(v > 0 && Number.isFinite(v))) continue;
                    if (v < 0.000001 || v > 200000) continue;

                    const k1 = `${q}->${baseCode}`;
                    const k2 = `${baseCode}->${q}`;
                    const inv = 1 / v;

                    if (Number.isFinite(inv) && inv > 0) {
                        (samples[k1] ||= { rates: [], ambCount: 0, evidence: "base-quote" }).rates.push(v);
                        (samples[k2] ||= { rates: [], ambCount: 0, evidence: "base-quote" }).rates.push(inv);
                        if (ambAny) { samples[k1].ambCount++; samples[k2].ambCount++; }
                    }
                }

                groupsUsed++;
            }
        }

        return samples;
    }

    function scoreSamples(sampleMap) {
        const out = {};
        const ts = Date.now();

        for (const pair of Object.keys(sampleMap || {})) {
            const rates = (sampleMap[pair]?.rates || []).filter(r => Number.isFinite(r) && r > 0);
            if (!rates.length) continue;

            const n = rates.length;
            const rMed = median(rates);
            const disp = relDispersionMAD(rates);
            const ambCount = sampleMap[pair]?.ambCount || 0;
            const ambiguous = ambCount > 0;

            let conf = 0.55;
            if (n >= 2) conf += 0.10;
            if (n >= 4) conf += 0.10;
            if (n >= 8) conf += 0.10;

            conf -= Math.min(0.40, disp * 1.3);
            if (ambiguous) conf -= 0.06;

            conf = Math.max(0.05, Math.min(0.95, conf));

            out[pair] = {
                rate: rMed,
                confidence: conf,
                evidence: sampleMap[pair]?.evidence || "site",
                nSamples: n,
                dispersion: disp,
                ts,
                ambiguous
            };
        }

        return out;
    }

    function mergeSampleMaps(a, b) {
        const out = { ...(a || {}) };
        for (const k of Object.keys(b || {})) {
            if (!out[k]) out[k] = b[k];
            else {
                out[k].rates = (out[k].rates || []).concat(b[k].rates || []);
                out[k].ambCount = (out[k].ambCount || 0) + (b[k].ambCount || 0);
                if (out[k].evidence === "dual-price" && b[k].evidence) out[k].evidence = b[k].evidence;
            }
        }
        return out;
    }

    function detectSiteRates(doc, host, settings, opts = {}) {
        host = normHost(host);

        const baseCode = (opts.baseCode && typeof opts.baseCode === "string")
            ? opts.baseCode.trim().toUpperCase()
            : null;

        // ✅ 0) Eğer kullanıcı USD/EUR selector girdiyse, heavy scan bypass
        const memo = new Map();
        const fromSelectors = inferFromRateSelectors(doc, host, settings, baseCode, memo);
        if (fromSelectors) {
            sccDbg("[rateSel] detectSiteRates using rateSelectors", {
                host,
                base: baseCode || null,
                keys: Object.keys(fromSelectors || {})
            });
            return fromSelectors;
        }

        // ✅ ADIM 1.6: forRates paramını roots’a geçir
        const roots = computeRoots(doc, host, settings, opts.selectors, !!opts.forRates);

        const s1 = inferFromDualPrice(roots, opts);
        const s2 = baseCode ? inferAgainstBase(roots, baseCode, opts) : {};

        const merged = mergeSampleMaps(s1, s2);
        return scoreSamples(merged);
    }

    globalThis.SCCSiteRateDetect = { detectSiteRates };
})();
