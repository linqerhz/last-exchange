// content/content.js
(() => {
    const BAR_ID = "scc-bar-host";
    const PICKER_HOST_ID = "scc-picker-host";

    const SCC_DEBUG = true;
    // ✅ diğer modüller (siteRateDetect) de görebilsin
    globalThis.SCC_DEBUG = SCC_DEBUG;

    function dbg(...a) { if (SCC_DEBUG) console.log("[SCC]", ...a); }
    dbg("content loaded", location.href);

    let BUSY = false;

    // storage.js gate değerleriyle uyumlu tut (bilerek sıkıysa dokunma)
    const SITE_MIN_CONF = 0.70;
    const SITE_MIN_SAMPLES = 3;
    const SITE_MAX_DISP = 0.03;

    function sendMessageAsync(msg) {
        return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
    }

    function safeUrl() {
        return location.href;
    }

    function safeHost() {
        try {
            return new URL(location.href).hostname.replace(/^www\./, "");
        } catch {
            return "";
        }
    }

    // ✅ Tek kaynak: content tarafında host her yerde normHost ile
    function getHostKey() {
        const raw = safeHost();
        const norm = globalThis.SCCStorage?.normHost;
        return typeof norm === "function" ? norm(raw) : String(raw || "").toLowerCase().replace(/^www\./, "");
    }

    // ✅ Pair key helper (content-side)
    function pairKey(from, to) {
        const f = String(from ?? "").trim().toUpperCase();
        const t = String(to ?? "").trim().toUpperCase();
        return `${f}->${t}`;
    }

    function parseUserNumber(raw) {
        if (raw == null) return null;

        let s = String(raw).replace(/\u00A0/g, " ").trim();
        s = s.replace(/[^\d.,\s-]/g, "");
        s = s.replace(/\s+/g, "");
        if (!s) return null;

        const hasDot = s.includes(".");
        const hasComma = s.includes(",");

        if (hasDot && hasComma) {
            const lastDot = s.lastIndexOf(".");
            const lastComma = s.lastIndexOf(",");
            const decSep = lastDot > lastComma ? "." : ",";
            const thouSep = decSep === "." ? "," : ".";
            s = s.split(thouSep).join("");
            s = s.replace(decSep, ".");
        } else if (hasDot || hasComma) {
            const sep = hasComma ? "," : ".";
            const last = s.lastIndexOf(sep);
            const fracLen = s.length - last - 1;

            if (fracLen === 1 || fracLen === 2) {
                s = s.split(sep === "," ? "." : ",").join("");
                s = s.replace(sep, ".");
            } else {
                s = s.split(sep).join("");
            }
        }

        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
        return n;
    }

    function fmtRateNumber(n) {
        if (!Number.isFinite(Number(n))) return "—";
        const v = Number(n);
        if (v === 0) return "0";
        if (v >= 1000) return v.toFixed(2);
        if (v >= 10) return v.toFixed(3);
        if (v >= 1) return v.toFixed(4);
        return v.toFixed(6);
    }

    // ---------------------------
    // BAR UI
    // ---------------------------

    function ensureBar() {
        let host = document.getElementById(BAR_ID);
        if (host) return host;

        host = document.createElement("div");
        host.id = BAR_ID;
        host.style.all = "initial";
        host.style.position = "fixed";
        host.style.top = "0";
        host.style.left = "0";
        host.style.right = "0";
        host.style.zIndex = "2147483647";
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `
      <style>
        .bar{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
             background:#111; color:#fff; border-bottom:1px solid #333;
             padding:10px 12px; display:flex; align-items:center; gap:10px;}
        .muted{color:#aaa; font-size:12px}
        .muted.warn{color:#ffcf66;}
        .muted.ok{color:#a8ffcc;}
        .manual{margin-top:6px; display:none; gap:6px; align-items:center; flex-wrap:wrap}
        .manual.show{display:flex;}
        .row{display:flex; gap:6px; align-items:center; font-size:12px; color:#ddd}
        input{background:#0f0f0f; color:#fff; border:1px solid #444; border-radius:8px;
              padding:6px 8px; width:120px; font-size:12px}
        button{background:#2a2a2a; color:#fff; border:1px solid #444; border-radius:10px;
               padding:8px 10px; cursor:pointer; font-size:13px}
        button.primary{background:#0b5; border-color:#0b5}
        button.ghost{background:transparent}
        button:disabled{opacity:.55; cursor:not-allowed}
        .spacer{flex:1}
      </style>
      <div class="bar">
        <div>
          <div id="title">Currency detected</div>
          <div class="muted" id="rates">USD: … • EUR: …</div>
          <div class="muted" id="sub">…</div>
          <div class="manual" id="manual">
            <div class="row" id="rowUsd">
              <span id="lblUsd">USD→BASE</span>
              <input id="inUsd" placeholder="83.50" inputmode="decimal" />
            </div>
            <div class="row" id="rowEur">
              <span id="lblEur">EUR→BASE</span>
              <input id="inEur" placeholder="90.20" inputmode="decimal" />
            </div>
            <button id="saveManual">Save rates</button>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="primary" id="toEur">Convert to EUR</button>
        <button class="primary" id="toUsd">Convert to USD</button>
        <button class="ghost" id="orig">Original</button>
        <button class="ghost" id="close">×</button>
      </div>
    `;
        return host;
    }

    function getShadow() {
        const host = document.getElementById(BAR_ID);
        return host?.shadowRoot || null;
    }

    function setBarBase(detection) {
        const shadow = getShadow();
        if (!shadow) return;

        const currency = detection?.currency || "";
        const confidence = typeof detection?.confidence === "number" ? detection.confidence : 0;
        const evidence = detection?.evidence || detection?.reason || "";

        shadow.getElementById("title").textContent =
            currency ? `Base: ${currency}` : "Currency not detected";

        const sub = shadow.getElementById("sub");
        sub.classList.remove("warn");
        sub.classList.remove("ok");
        sub.textContent =
            currency
                ? `confidence=${Math.round(confidence * 100)}% • ${evidence || "signal"}`
                : "No reliable signal found";
    }

    function setStatus(text, isWarn = false) {
        const shadow = getShadow();
        if (!shadow) return;
        const el = shadow.getElementById("sub");
        el.textContent = text;
        el.classList.toggle("warn", !!isWarn);
        el.classList.toggle("ok", !isWarn);
    }

    function setBusy(isBusy, message) {
        const shadow = getShadow();
        if (!shadow) return;

        shadow.getElementById("toEur").disabled = isBusy;
        shadow.getElementById("toUsd").disabled = isBusy;
        shadow.getElementById("orig").disabled = isBusy;

        if (message) setStatus(message, false);
    }

    function setRatesLine(base, usdPick, eurPick) {
        const shadow = getShadow();
        if (!shadow) return;

        const baseUp = String(base || "").toUpperCase();
        const usdRate = usdPick?.rate;
        const eurRate = eurPick?.rate;

        const usdTxt = (baseUp === "USD") ? "1" : fmtRateNumber(usdRate);
        const eurTxt = (baseUp === "EUR") ? "1" : fmtRateNumber(eurRate);

        shadow.getElementById("rates").textContent =
            `USD: ${usdTxt}${baseUp ? " " + baseUp : ""} • EUR: ${eurTxt}${baseUp ? " " + baseUp : ""}`;
    }

    function setManualPanel(base, missingUsd, missingEur) {
        const shadow = getShadow();
        if (!shadow) return;

        const baseUp = String(base || "").toUpperCase();
        const manual = shadow.getElementById("manual");
        const rowUsd = shadow.getElementById("rowUsd");
        const rowEur = shadow.getElementById("rowEur");
        const lblUsd = shadow.getElementById("lblUsd");
        const lblEur = shadow.getElementById("lblEur");

        const showUsd = !!missingUsd && baseUp !== "USD";
        const showEur = !!missingEur && baseUp !== "EUR";

        rowUsd.style.display = showUsd ? "flex" : "none";
        rowEur.style.display = showEur ? "flex" : "none";

        lblUsd.textContent = `1 USD = ? ${baseUp || "BASE"}`;
        lblEur.textContent = `1 EUR = ? ${baseUp || "BASE"}`;

        manual.classList.toggle("show", showUsd || showEur);
    }

    // ---------------------------
    // DETECT
    // ---------------------------

    async function detectCurrentWithSettings(settings) {
        return await SCCDetect.detectPageCurrency(document, safeUrl(), settings);
    }

    async function detectCurrent() {
        const settings = await SCCStorage.getSettings();
        const detection = await SCCDetect.detectPageCurrency(document, safeUrl(), settings);
        return { settings, detection };
    }

    // ---------------------------
    // SITE RATE: ensure cache fresh (TTL cache -> detect -> write)
    // ---------------------------
    function isValidRateNumber(x) {
        const n = (typeof x === "number") ? x : Number(String(x).replace(",", "."));
        return Number.isFinite(n) && n > 0.000001 && n < 200000;
    }

    function normalizePairsMap(pairs) {
        if (!pairs || typeof pairs !== "object") return null;

        const out = {};
        for (const [k, v] of Object.entries(pairs)) {
            if (!k) continue;

            // expected: {rate, confidence...}
            if (v && typeof v === "object") {
                const r = v.rate;
                if (isValidRateNumber(r)) out[k] = { ...v, rate: Number(String(r).replace(",", ".")) };
                continue;
            }

            // tolerate legacy numbers/strings
            if (isValidRateNumber(v)) out[k] = { rate: Number(String(v).replace(",", ".")), confidence: 0.4, evidence: "legacy" };
        }
        return Object.keys(out).length ? out : null;
    }

    function cacheHasRequiredPairs(cachedPairs, requiredPairs) {
        if (!cachedPairs || typeof cachedPairs !== "object") return false;
        if (!Array.isArray(requiredPairs) || !requiredPairs.length) return true;

        for (const k of requiredPairs) {
            const p = cachedPairs[k];
            const r = (p && typeof p === "object") ? p.rate : p;
            if (isValidRateNumber(r)) return true; // ✅ ANY-match + valid rate
        }
        return false;
    }

    async function ensureSitePairsFresh(settings, host, selectors, baseCode, requiredPairs = []) {
        const rs = settings?.rateSelectorsByHost?.[host];
        dbg("ensureSitePairsFresh:start", {
            host,
            baseCode: baseCode || null,
            requiredPairsCount: Array.isArray(requiredPairs) ? requiredPairs.length : 0,
            selectorsCount: Array.isArray(selectors) ? selectors.length : 0,
            rateSelectors: rs ? Object.keys(rs) : [], // ✅ kanıt
        });

        // settings içindeki raw entry (diagnostic için)
        const cachedHostEntry = settings?.siteRatesByHost?.[host] || null;

        let cachedPairs = null;
        try {
            // TTL uygulanmış pairs döner (storage.js)
            cachedPairs = await SCCStorage.getSitePairsForHost(host, false);
            cachedPairs = normalizePairsMap(cachedPairs);

            if (cachedPairs && cacheHasRequiredPairs(cachedPairs, requiredPairs)) {
                dbg("ensureSitePairsFresh:cache_hit_required_valid", {
                    keys: Object.keys(cachedPairs).slice(0, 10),
                });
                return cachedPairs;
            }

            // cache var ama required pair rate invalid/missing → sample kanıt
            if (cachedHostEntry?.pairs) {
                const sample = (requiredPairs || []).slice(0, 6).map(k => [k, cachedHostEntry.pairs?.[k]?.rate]);
                dbg("ensureSitePairsFresh:cache_present_but_invalid_or_missing_required", { sample });
            } else {
                dbg("ensureSitePairsFresh:cache_miss_required", {
                    haveCache: !!cachedPairs,
                    sampleKeys: cachedPairs ? Object.keys(cachedPairs).slice(0, 10) : null
                });
            }
        } catch (e) {
            dbg("ensureSitePairsFresh:cache_error", String(e?.message || e));
        }

        const det = globalThis.SCCSiteRateDetect?.detectSiteRates;
        if (typeof det !== "function") {
            dbg("ensureSitePairsFresh:no_detector", typeof det);
            return cachedPairs || null;
        }

        let detectedPairs = null;
        try {
            detectedPairs = det(document, host, settings, {
                selectors,
                baseCode: baseCode || null,
                forRates: true,
                maxEls: 2200,
                budgetMs: 28
            }) || null;

            detectedPairs = normalizePairsMap(detectedPairs);

            dbg("ensureSitePairsFresh:detected", {
                ok: !!detectedPairs,
                keyCount: detectedPairs ? Object.keys(detectedPairs).length : 0,
                keys: detectedPairs ? Object.keys(detectedPairs).slice(0, 10) : null
            });
        } catch (e) {
            dbg("ensureSitePairsFresh:detect_error", String(e?.message || e));
            detectedPairs = null;
        }

        // ✅ merge: önce cache(valid) sonra detect(valid) (detect override)
        const merged = (() => {
            const a = cachedPairs || null;
            const b = detectedPairs || null;
            if (a && b) return { ...a, ...b };
            return a || b || null;
        })();

        // ✅ cache yaz: sadece “en az 1 valid pair” varsa (normalize buna garanti verir)
        try {
            if (merged && typeof merged === "object" && Object.keys(merged).length) {
                await SCCStorage.setSitePairsForHost(host, merged);
                dbg("ensureSitePairsFresh:cache_write_ok", { keyCount: Object.keys(merged).length });
            } else {
                dbg("ensureSitePairsFresh:cache_write_skip");
            }
        } catch (e) {
            dbg("ensureSitePairsFresh:cache_write_error", String(e?.message || e));
        }

        return merged;
    }


    function formatRateSource(pick) {
        if (!pick) return "UNKNOWN";
        if (pick.source === "SITE") {
            const conf = Number(pick.confidence || 0).toFixed(2);
            const n = Number(pick.nSamples || 0);
            const d = Number(pick.dispersion || 0).toFixed(3);
            return `SITE • conf=${conf} n=${n} disp=${d} • ${pick.evidence || "site"}`;
        }
        if (pick.source === "PINNED") return "PINNED";
        if (pick.source === "MANUAL_HOST") return "MANUAL_HOST";
        if (pick.source === "MANUAL_LEGACY") return "MANUAL_LEGACY";
        if (pick.source === "API") return "API";
        if (pick.source === "IDENTITY") return "IDENTITY";
        return String(pick.source || "UNKNOWN");
    }

    // ✅ refreshRatesUI requiredPairs üretir + host norm uyumlu
    async function refreshRatesUI(baseCurrency) {
        const shadow = getShadow();
        if (!shadow) return;

        const base = String(baseCurrency || "").trim().toUpperCase();
        const host = getHostKey();
        const settings = await SCCStorage.getSettings();
        const selectors = settings?.customSelectorsByHost?.[host] || [];

        const need = [];
        if (base && base !== "USD") need.push(pairKey("USD", base), pairKey(base, "USD"));
        if (base && base !== "EUR") need.push(pairKey("EUR", base), pairKey(base, "EUR"));

        await ensureSitePairsFresh(settings, host, selectors, base || null, need);
        const freshSettings = await SCCStorage.getSettings();

        const picker = SCCStorage.pickBestRateFromSettings;

        const pickDirect = (from, to) => {
            if (!from || !to) return null;
            if (String(from).toUpperCase() === String(to).toUpperCase()) {
                return { rate: 1, confidence: 1.0, evidence: "identity", source: "IDENTITY" };
            }
            return picker?.(freshSettings, host, from, to, {
                minConf: SITE_MIN_CONF,
                minSamples: SITE_MIN_SAMPLES,
                maxDisp: SITE_MAX_DISP
            }) || null;
        };

        const usdPick = pickDirect("USD", base);
        const eurPick = pickDirect("EUR", base);

        const usdOk = !!(usdPick && isValidRateNumber(usdPick.rate));
        const eurOk = !!(eurPick && isValidRateNumber(eurPick.rate));


        setRatesLine(base, usdPick, eurPick);
        setManualPanel(base, !usdOk, !eurOk);

        const usdMsg = usdOk ? `USD ok (${usdPick.source || "?"})` : "USD not found (local)";
        const eurMsg = eurOk ? `EUR ok (${eurPick.source || "?"})` : "EUR not found (local)";
        setStatus(`${usdMsg} / ${eurMsg}`, !(usdOk && eurOk));

        shadow.getElementById("saveManual").onclick = () => runAction(async () => {
            const baseUp = String(base || "").toUpperCase();
            if (!baseUp) return;

            const inUsd = shadow.getElementById("inUsd");
            const inEur = shadow.getElementById("inEur");
            const usdVal = parseUserNumber(inUsd?.value);
            const eurVal = parseUserNumber(inEur?.value);

            const patch = {};
            if (baseUp !== "USD" && usdVal && usdVal > 0) patch[`USD->${baseUp}`] = usdVal;
            if (baseUp !== "EUR" && eurVal && eurVal > 0) patch[`EUR->${baseUp}`] = eurVal;

            if (!Object.keys(patch).length) {
                setStatus("Nothing to save (enter a valid number).", true);
                return;
            }

            setBusy(true, "Saving manual rates…");
            try {
                await SCCStorage.setManualRatesForHost(host, patch);
                if (inUsd) inUsd.value = "";
                if (inEur) inEur.value = "";
                await refreshRatesUI(baseUp);
            } catch (e) {
                setStatus(String(e?.message || e), true);
            } finally {
                setBusy(false);
            }
        });
    }

    async function resolveRate(settings, host, from, to, selectors) {
        dbg("resolveRate: starting...", { from, to, host });

        const req = [pairKey(from, to), pairKey(to, from)];
        await ensureSitePairsFresh(settings, host, selectors, from, req);

        const freshSettings = await SCCStorage.getSettings();

        const picker = SCCStorage.pickBestRateFromSettings;
        if (typeof picker === "function") {
            const picked = picker(freshSettings, host, from, to, {
                minConf: SITE_MIN_CONF,
                minSamples: SITE_MIN_SAMPLES,
                maxDisp: SITE_MAX_DISP
            });

            dbg("resolveRate:picked", {
                host, from, to,
                picked: picked ? { source: picked.source, rate: picked.rate, conf: picked.confidence, ev: picked.evidence } : null
            });

            if (picked && isValidRateNumber(picked.rate)) {
                const rate = Number(String(picked.rate).replace(",", "."));
                dbg("resolveRate: SUCCESS (Site/Pinned/Manual)", { rate, source: picked.source, conf: picked.confidence });
                return { ...picked, rate };
            }
        }
        dbg("resolveRate: picked=null => will_call_GET_RATE", { host, from, to });

        dbg("resolveRate: FALLBACK to API", { reason: "No valid picked rate (site/pinned/manual) - trying API" });

        const resp = await sendMessageAsync({ type: "GET_RATE", host, from, to });
        if (!resp?.ok) throw new Error(resp?.error || "rate error");

        dbg("resolveRate: API SUCCESS", { rate: resp.rate });
        return { rate: resp.rate, source: "API", confidence: 1.0, evidence: "api" };
    }


    // ---------------------------
    // AUTO-RETRY: scope baskın currency
    // ---------------------------

    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function isLeafish(el) {
        if (!el || !(el instanceof Element)) return false;
        if (el.closest(`#${BAR_ID}`) || el.closest(`#${PICKER_HOST_ID}`)) return false;
        if (el.childElementCount > 2) return false;
        if (el.querySelector("input,textarea,select,button,svg,canvas")) return false;
        return true;
    }

    function normTokenToCode(tok) {
        if (!tok) return null;

        const MAPS = globalThis.SCC_MAPS || {};
        if (typeof MAPS.getCodesForSymbol === "function") {
            const codes = MAPS.getCodesForSymbol(tok);
            if (codes) return Array.isArray(codes) ? codes[0] : codes;
        }

        const up = String(tok).trim().toUpperCase();
        if ((MAPS.SOURCE_CURRENCIES || []).includes(up)) return up;

        return null;
    }

    function guessDominantCurrencyInScope(selectors) {
        const counts = new Map();
        const start = (globalThis.performance && performance.now) ? performance.now() : Date.now();
        const maxEls = 1200;
        const budgetMs = 16;

        const roots = [];
        if (Array.isArray(selectors) && selectors.length) {
            for (const sel of selectors) {
                try { document.querySelectorAll(sel).forEach(el => roots.push(el)); } catch { }
            }
        }
        if (!roots.length) roots.push(document.body || document.documentElement);

        const MAPS = globalThis.SCC_MAPS || {};
        const symKeys = Object.keys(MAPS.SYMBOL_TO_CODES || {}).sort((a, b) => b.length - a.length);
        const codes = (MAPS.CODE_TOKENS || []).slice();

        let walked = 0;

        for (const root of roots) {
            if (!root) continue;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
                acceptNode(node) {
                    if (!(node instanceof Element)) return NodeFilter.FILTER_REJECT;
                    if (!isLeafish(node)) return NodeFilter.FILTER_SKIP;

                    const t = (node.textContent || "").replace(/\u00A0/g, " ").trim();
                    if (!t) return NodeFilter.FILTER_SKIP;
                    if (t.length < 3 || t.length > 180) return NodeFilter.FILTER_SKIP;
                    if (!/\d/.test(t)) return NodeFilter.FILTER_SKIP;

                    let ok = false;
                    for (const sym of symKeys) { if (t.includes(sym)) { ok = true; break; } }
                    if (!ok) {
                        for (const c of codes) {
                            const re = new RegExp(`\\b${escapeRegExp(c)}\\b`, "i");
                            if (re.test(t)) { ok = true; break; }
                        }
                    }
                    return ok ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });

            while (walker.nextNode()) {
                walked++;
                const now = (globalThis.performance && performance.now) ? performance.now() : Date.now();
                if (walked > maxEls) break;
                if ((now - start) > budgetMs) break;

                const el = walker.currentNode;
                const txt = (el.textContent || "").replace(/\u00A0/g, " ").trim();
                if (!txt) continue;

                for (const sym of symKeys) {
                    if (txt.includes(sym)) {
                        const code = normTokenToCode(sym);
                        if (code) counts.set(code, (counts.get(code) || 0) + 2);
                    }
                }

                for (const c of codes) {
                    const re = new RegExp(`\\b${escapeRegExp(c)}\\b`, "i");
                    if (re.test(txt)) counts.set(c, (counts.get(c) || 0) + 2);
                }
            }
        }

        let best = null;
        let bestScore = 0;
        for (const [cur, sc] of counts.entries()) {
            if (sc > bestScore) { bestScore = sc; best = cur; }
        }
        if (!best) return null;
        return { currency: best, score: bestScore, evidence: "scope-token" };
    }

    // ---------------------------
    // Convert
    // ---------------------------

    async function convertTo(targetCurrency) {
        const settings = await SCCStorage.getSettings();

        if (targetCurrency === "ORIGINAL") {
            const r = SCCConvert.revert();
            return { ok: true, reverted: r?.count || 0 };
        }

        // zincir dönüşüm için önce revert
        SCCConvert.revert();

        const detection = await detectCurrentWithSettings(settings);
        const detectedFrom = detection?.currency;
        try { setBarBase(detection); } catch { }

        if (!detectedFrom) {
            return { ok: false, error: "Currency not detected. Use domain override or selector." };
        }

        const host = getHostKey();
        const selectors = settings?.customSelectorsByHost?.[host] || [];

        const pick = await resolveRate(settings, host, detectedFrom, targetCurrency, selectors);
        const rateSource = formatRateSource(pick);

        let r = SCCConvert.convert({
            fromCurrency: detectedFrom,
            toCurrency: targetCurrency,
            rate: pick.rate,
            selectors
        });

        if ((r?.count || 0) === 0) {
            const guessed = guessDominantCurrencyInScope(selectors);
            const guessedFrom = guessed?.currency;

            if (guessedFrom && guessedFrom !== detectedFrom) {
                SCCConvert.revert();

                const pick2 = await resolveRate(settings, host, guessedFrom, targetCurrency, selectors);
                const rateSource2 = formatRateSource(pick2);

                r = SCCConvert.convert({
                    fromCurrency: guessedFrom,
                    toCurrency: targetCurrency,
                    rate: pick2.rate,
                    selectors
                });

                return {
                    ok: true,
                    converted: r?.count || 0,
                    from: guessedFrom,
                    to: targetCurrency,
                    rate: pick2.rate,
                    rateSource: rateSource2,
                    retried: true,
                    detectedFrom,
                    guessEvidence: guessed?.evidence || "scope-token"
                };
            }
        }

        return {
            ok: true,
            converted: r?.count || 0,
            from: detectedFrom,
            to: targetCurrency,
            rate: pick.rate,
            rateSource,
            retried: false
        };
    }

    async function runAction(fn) {
        if (BUSY) return;
        BUSY = true;
        try {
            await fn();
        } finally {
            BUSY = false;
        }
    }

    async function maybeShowPrompt() {
        const settings = await SCCStorage.getSettings();
        if (!settings?.autoPrompt) return;

        const { detection } = await detectCurrent();
        if (!detection?.currency) return;

        ensureBar();
        setBarBase(detection);

        // ✅ ADIM 3: SPA footer geç render -> 1 retry warmup
        (async () => {
            try {
                const host = getHostKey();
                const selectors = settings?.customSelectorsByHost?.[host] || [];
                const base = detection?.currency ? String(detection.currency).toUpperCase() : null;
                if (!base) return;

                const need = [];
                if (base !== "USD") need.push(pairKey("USD", base), pairKey(base, "USD"));
                if (base !== "EUR") need.push(pairKey("EUR", base), pairKey(base, "EUR"));

                dbg("[ratesWarmup] pass=1", { host, base, needCount: need.length });
                await ensureSitePairsFresh(settings, host, selectors, base, need);
                try { await refreshRatesUI(base); } catch { }

                setTimeout(async () => {
                    try {
                        const s2 = await SCCStorage.getSettings();
                        dbg("[ratesWarmup] pass=2", { host, base, needCount: need.length });
                        await ensureSitePairsFresh(s2, host, selectors, base, need);
                        try { await refreshRatesUI(base); } catch { }
                    } catch (e2) {
                        dbg("[ratesWarmup] pass=2 error", String(e2?.message || e2));
                    }
                }, 1200);
            } catch (e) {
                dbg("[ratesWarmup] error", String(e?.message || e));
            }
        })();

        const shadow = getShadow();
        if (!shadow) return;

        const doConvert = (target) => runAction(async () => {
            setBusy(true, target === "ORIGINAL" ? "Reverting…" : "Converting…");
            try {
                const out = await convertTo(target);

                if (!out.ok) {
                    setStatus(out.error || "Conversion failed.", true);
                    return;
                }

                if (target === "ORIGINAL") {
                    setStatus(`Reverted: ${out.reverted || 0}`);
                    return;
                }

                const n = out.converted || 0;
                if (n <= 0) {
                    setStatus("No prices converted. Add a CSS selector in popup.", true);
                    return;
                }

                setStatus(`Converted: ${n} • ${out.from}->${out.to} • ${out.rateSource}`);
                try { await refreshRatesUI(out.from); } catch { }
            } catch (e) {
                setStatus(String(e?.message || e), true);
            } finally {
                setBusy(false);
            }
        });

        shadow.getElementById("toEur").onclick = () => doConvert("EUR");
        shadow.getElementById("toUsd").onclick = () => doConvert("USD");
        shadow.getElementById("orig").onclick = () => doConvert("ORIGINAL");

        shadow.getElementById("close").onclick = () => {
            document.getElementById(BAR_ID)?.remove();
        };
    }

    // ---------------------------
    // Picker (fiyat scope selector)
    // ---------------------------

    let PICKER_ACTIVE = false;
    let PICKER_LAST_HL = null;

    function cssEscapeSafe(s) {
        try { return CSS.escape(s); } catch { return String(s).replace(/["\\]/g, "\\$&"); }
    }

    function inOurUiEvent(e) {
        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        return path.some(n => n && (n.id === BAR_ID || n.id === PICKER_HOST_ID));
    }

    function ensureGlobalPickerHighlightStyle() {
        if (document.getElementById("scc-picker-highlight-style")) return;

        const st = document.createElement("style");
        st.id = "scc-picker-highlight-style";
        st.textContent = `.scc-hl { outline: 2px solid #ffcc00 !important; cursor: crosshair !important; }`;
        document.documentElement.appendChild(st);
    }

    function ensurePickerUI() {
        let host = document.getElementById(PICKER_HOST_ID);
        if (host) return host;

        host = document.createElement("div");
        host.id = PICKER_HOST_ID;
        host.style.all = "initial";
        host.style.position = "fixed";
        host.style.top = "0";
        host.style.left = "0";
        host.style.right = "0";
        host.style.zIndex = "2147483647";
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `
      <style>
        .bar{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
          background:#3b0b0b; color:#fff; border-bottom:1px solid #5a1a1a;
          padding:8px 10px; display:flex; align-items:center; gap:10px;}
        .msg{font-size:12px; opacity:.95}
        .spacer{flex:1}
        button{background:#757575; color:#fff; border:1px solid #888; border-radius:10px;
          padding:6px 10px; cursor:pointer; font-size:12px}
      </style>
      <div class="bar">
        <div class="msg" id="pickerMsg">Picker: fiyat alanına tıkla (ESC = çıkış)</div>
        <div class="spacer"></div>
        <button id="pickerCancel">Çıkış</button>
      </div>
    `;
        shadow.getElementById("pickerCancel").onclick = () => {
            if (PICKER_ACTIVE) stopPickerMode();
            if (RATE_PICKER_ACTIVE) stopRatePickerMode();
        };
        return host;
    }

    function setPickerMsg(text) {
        const host = document.getElementById(PICKER_HOST_ID);
        const msg = host?.shadowRoot?.getElementById("pickerMsg");
        if (msg) msg.textContent = text;
    }

    function addHighlight(el) {
        if (!el || !(el instanceof Element)) return;
        if (PICKER_LAST_HL && PICKER_LAST_HL !== el) {
            try { PICKER_LAST_HL.classList.remove("scc-hl"); } catch { }
        }
        PICKER_LAST_HL = el;
        try { el.classList.add("scc-hl"); } catch { }
    }

    function removeHighlight() {
        if (PICKER_LAST_HL) {
            try { PICKER_LAST_HL.classList.remove("scc-hl"); } catch { }
        }
        PICKER_LAST_HL = null;
    }

    function hasPriceKeywordLocal(el) {
        const s = `${el.id || ""} ${el.className || ""} ${el.getAttribute("data-test-id") || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
        return /(price|amount|total|cost|fare|rate|sum|payment|cena|koszt|platn|oplata)/i.test(s);
    }

    function buildAnyCurrencyTokenRegex() {
        const MAPS = globalThis.SCC_MAPS || {};
        const syms = Object.keys(MAPS.SYMBOL_TO_CODES || {}).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const codes = (MAPS.CODE_TOKENS || []).map(x => `\\b${x}\\b`);
        const toks = [...syms, ...codes].sort((a, b) => b.length - a.length).join("|");
        if (!toks) return null;
        return new RegExp(`(${toks})`, "i");
    }

    const ANY_TOK_RE2 = buildAnyCurrencyTokenRegex();
    const PRICE_LIKE_RE_1 = /([0-9][0-9\s.,]{0,20})\s*([^\s]{1,6})/i;
    const PRICE_LIKE_RE_2 = /([^\s]{1,6})\s*([0-9][0-9\s.,]{0,20})/i;

    function countPriceLike(el) {
        const t = (el.textContent || "").trim();
        if (!t) return 0;
        if (t.length > 50000) return 0;
        if (!/\d/.test(t)) return 0;

        let score = 0;
        if (ANY_TOK_RE2 && ANY_TOK_RE2.test(t)) score += 2;
        if (PRICE_LIKE_RE_1.test(t) || PRICE_LIKE_RE_2.test(t)) score += 2;
        if (hasPriceKeywordLocal(el)) score += 1;

        const nums = t.match(/\d[\d\s.,]{0,10}/g);
        if (nums && nums.length >= 3) score += 1;

        return score;
    }

    function pickBestScope(startEl) {
        let best = startEl;
        let bestScore = -1;

        let el = startEl;
        for (let i = 0; i < 7 && el && el !== document.body && el !== document.documentElement; i++) {
            const sc = countPriceLike(el);
            if (sc > bestScore) {
                bestScore = sc;
                best = el;
            }
            el = el.parentElement;
        }
        return best || startEl;
    }

    function selectorForElement(el) {
        if (!el || !(el instanceof Element)) return null;

        if (el.id) return `#${cssEscapeSafe(el.id)}`;

        const dti = el.getAttribute("data-test-id");
        if (dti) return `[data-test-id="${cssEscapeSafe(dti)}"]`;

        const tag = el.tagName.toLowerCase();
        const classes = Array.from(el.classList || [])
            .filter(c => c && c.length >= 3 && c.length <= 40)
            .filter(c => !/\d{3,}/.test(c))
            .filter(c => !/^(css-|sc-|jss-|chakra-|Mui)/i.test(c))
            .slice(0, 3);

        if (classes.length) return `${tag}.${classes.map(cssEscapeSafe).join(".")}`;
        return tag;
    }

    async function saveScopeSelector(sel) {
        const host = getHostKey();
        if (!host) return false;
        await SCCStorage.addCustomSelector(host, sel);
        return true;
    }

    function onPickerMove(e) {
        if (!(PICKER_ACTIVE || RATE_PICKER_ACTIVE)) return;
        if (inOurUiEvent(e)) return;

        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t === document.body || t === document.documentElement) return;
        addHighlight(t);
    }

    function onPickerKey(e) {
        if (!(PICKER_ACTIVE || RATE_PICKER_ACTIVE)) return;
        if (e.key === "Escape") {
            if (PICKER_ACTIVE) stopPickerMode();
            if (RATE_PICKER_ACTIVE) stopRatePickerMode();
        }
    }

    function onPickerClick(e) {
        if (!PICKER_ACTIVE) return;
        if (inOurUiEvent(e)) return;

        e.preventDefault();
        e.stopPropagation();

        const target = e.target;
        if (!(target instanceof Element)) return;

        const scope = pickBestScope(target);
        const sel = selectorForElement(scope);

        if (!sel) {
            setPickerMsg("Selector üretilemedi.");
            return;
        }

        setPickerMsg(`Kaydediliyor: ${sel}`);

        (async () => {
            try {
                await saveScopeSelector(sel);
                setPickerMsg(`Saved scope: ${sel}`);
                setTimeout(() => stopPickerMode(), 600);
            } catch (err) {
                setPickerMsg(`Save failed: ${String(err?.message || err)}`);
            }
        })();
    }

    function startPickerMode() {
        // aynı anda rate picker açık olmasın
        if (RATE_PICKER_ACTIVE) stopRatePickerMode();

        if (PICKER_ACTIVE) return;
        PICKER_ACTIVE = true;

        ensureGlobalPickerHighlightStyle();
        ensurePickerUI();
        removeHighlight();

        try { SCCConvert?.revert?.(); } catch { }

        setPickerMsg("Picker: fiyat alanına tıkla (ESC = çıkış)");

        document.addEventListener("mousemove", onPickerMove, true);
        document.addEventListener("click", onPickerClick, true);
        document.addEventListener("keydown", onPickerKey, true);
    }

    function stopPickerMode() {
        if (!PICKER_ACTIVE) return;
        PICKER_ACTIVE = false;

        document.removeEventListener("mousemove", onPickerMove, true);
        document.removeEventListener("click", onPickerClick, true);
        document.removeEventListener("keydown", onPickerKey, true);

        removeHighlight();
        document.getElementById(PICKER_HOST_ID)?.remove();
        document.getElementById("scc-picker-highlight-style")?.remove();
    }

    // ---------------------------
    // Rate Picker (USD/EUR selector picker) — ADIM 2
    // ---------------------------

    let RATE_PICKER_ACTIVE = false;
    let RATE_PICKER_QUOTE = null;

    function textLooksRateyLocal(t, quote) {
        const s = String(t || "");
        if (!/\d/.test(s)) return false;
        const hasQuote = new RegExp(`\\b${quote}\\b`, "i").test(s) || /[$€₽₺]/.test(s);
        const hasHints = /(=|rate|exchange|currency|kurs|kur|doviz|курс|валют)/i.test(s);
        return hasQuote || hasHints;
    }

    function pickRateContainer(startEl, quote) {
        let el = startEl;
        for (let i = 0; i < 8 && el && el !== document.body && el !== document.documentElement; i++) {
            const t = (el.innerText || el.textContent || "").replace(/\u00A0/g, " ").trim();
            if (t && t.length <= 400 && textLooksRateyLocal(t, quote)) {
                if (/\d/.test(t)) return el;
            }
            el = el.parentElement;
        }
        return startEl;
    }

    function makeUniqueSelector(sel, el) {
        try {
            const all = document.querySelectorAll(sel);
            if (all.length === 1) return sel;

            const tag = el.tagName.toLowerCase();
            const sibs = Array.from(el.parentElement?.children || []).filter(x => x.tagName?.toLowerCase() === tag);
            const idx = sibs.indexOf(el);
            if (idx >= 0) return `${sel}:nth-of-type(${idx + 1})`;
        } catch { }
        return sel;
    }

    function selectorForRateElement(el) {
        const baseSel = selectorForElement(el);
        if (!baseSel) return null;
        return makeUniqueSelector(baseSel, el);
    }

    async function startRatePickerMode(quoteCode) {
        // aynı anda scope picker açık olmasın
        if (PICKER_ACTIVE) stopPickerMode();

        if (RATE_PICKER_ACTIVE) return;
        RATE_PICKER_ACTIVE = true;
        RATE_PICKER_QUOTE = String(quoteCode || "").toUpperCase();

        ensureGlobalPickerHighlightStyle();
        ensurePickerUI();
        setPickerMsg(`Rate Picker: ${RATE_PICKER_QUOTE} satırına tıkla (ESC = çıkış)`);

        document.addEventListener("mousemove", onPickerMove, true);
        document.addEventListener("click", onRatePickerClick, true);
        document.addEventListener("keydown", onPickerKey, true);
    }

    function stopRatePickerMode() {
        if (!RATE_PICKER_ACTIVE) return;
        RATE_PICKER_ACTIVE = false;
        RATE_PICKER_QUOTE = null;

        document.removeEventListener("mousemove", onPickerMove, true);
        document.removeEventListener("click", onRatePickerClick, true);
        document.removeEventListener("keydown", onPickerKey, true);

        removeHighlight();
        document.getElementById(PICKER_HOST_ID)?.remove();
    }

    function onRatePickerClick(e) {
        if (!RATE_PICKER_ACTIVE) return;
        if (inOurUiEvent(e)) return;

        e.preventDefault();
        e.stopPropagation();

        const target = e.target;
        if (!(target instanceof Element)) return;

        const quote = RATE_PICKER_QUOTE;
        const container = pickRateContainer(target, quote);
        const sel = selectorForRateElement(container);

        const sample = (container.innerText || container.textContent || "").replace(/\u00A0/g, " ").trim().slice(0, 220);
        dbg("[ratePick]", { quote, host: getHostKey(), sel, sample });

        if (!sel) {
            setPickerMsg("Rate selector üretilemedi.");
            return;
        }

        setPickerMsg(`Kaydediliyor (${quote}): ${sel}`);

        (async () => {
            try {
                const host = getHostKey();
                await SCCStorage.setRateSelector(host, quote, sel);
                setPickerMsg(`Saved ${quote} selector: ${sel}`);
                setTimeout(() => stopRatePickerMode(), 700);
            } catch (err) {
                setPickerMsg(`Save failed: ${String(err?.message || err)}`);
            }
        })();
    }

    // ---------------------------
    // Popup komutları
    // ---------------------------

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        (async () => {
            try {
                if (msg?.type === "START_PICKER") {
                    startPickerMode();
                    sendResponse({ ok: true });
                    return;
                }

                if (msg?.type === "STOP_PICKER") {
                    stopPickerMode();
                    sendResponse({ ok: true });
                    return;
                }

                if (msg?.type === "START_RATE_PICKER") {
                    const quote = msg.quoteCode || "USD";
                    await startRatePickerMode(quote);
                    sendResponse({ ok: true });
                    return;
                }

                if (msg?.type === "STOP_RATE_PICKER") {
                    stopRatePickerMode();
                    sendResponse({ ok: true });
                    return;
                }

                if (msg?.type === "DETECT") {
                    const { detection } = await detectCurrent();
                    sendResponse({ ok: true, detection });
                    return;
                }

                if (msg?.type === "CONVERT") {
                    const target = msg.target || "EUR";
                    const out = await convertTo(target);
                    sendResponse(out);
                    return;
                }

                if (msg?.type === "REVERT") {
                    const r = SCCConvert.revert();
                    sendResponse({ ok: true, reverted: r?.count || 0 });
                    return;
                }

                sendResponse({ ok: false, error: "Unknown message" });
            } catch (e) {
                sendResponse({ ok: false, error: String(e?.message || e) });
            }
        })();
        return true;
    });

    // init
    maybeShowPrompt();
})();
