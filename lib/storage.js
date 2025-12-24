// lib/storage.js
(() => {
    /**

     *
     * RATE SELECTOR FIX:
     * - rateSelectorsByHost yazarken host normalize şart.
     * - selector değişince siteRatesByHost cache invalidate şart (poison / stale bypass).
     */

    function freshDefaults() {
        return {
            targetCurrency: "EUR",
            autoPrompt: true,
            autoConvert: false,

            domainCurrencyOverride: {}, // { "example.com": "RUB" }
            customSelectorsByHost: {},  // { "example.com": [".price", ".amount"] }

            // RATE WIDGET SELECTOR (host bazlı)
            rateSelectorsByHost: {},    // { "example.com": { USD: "<css>|null", EUR: "<css>|null" } }

            // --- LEGACY ---
            manualRateByPair: {},       // { "RUB->EUR": 0.0102 }

            // --- YENİ ŞEMA ---
            manualRatesByHost: {},      // { "example.com": { pairs: { "USD->RUB": { rate, ts } } } }
            rateModeByHost: {},
            pinnedRatesByHost: {},      // { "example.com": { pairs: { "USD->RUB": { rate, tsPinned, confidence, evidence, nSamples, dispersion } } } }
            siteRatesByHost: {},        // { "example.com": { ts: 1690000000000, pairs: { "USD->RUB": {...} } } }

            // Site rate TTL (varsayılan 6 saat)
            siteRateTtlMs: 6 * 60 * 60 * 1000,
        };
    }

    function storageGet(keys) {
        return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }

    function storageSet(obj) {
        return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    }

    function cloneObj(o) {
        return o && typeof o === "object" ? { ...o } : {};
    }

    function normHost(x) {
        let s = String(x || "").trim();
        try {
            if (s.startsWith("http://") || s.startsWith("https://")) s = new URL(s).hostname;
        } catch {}
        s = s.toLowerCase();
        s = s.replace(/^www\./, "");
        s = s.replace(/:\d+$/, "");
        return s;
    }

    function sanitizeSelector(selector) {
        if (!selector) return "";
        return String(selector)
            .replace(/\.scc-hl\b/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }


    function safeHostFromUrl(url) {
        try {
            return normHost(new URL(url).hostname);
        } catch {
            return "";
        }
    }

    function pairKey(from, to) {
        const f = String(from ?? "").trim().toUpperCase();
        const t = String(to ?? "").trim().toUpperCase();
        return `${f}->${t}`;
    }

    function isFresh(ts, ttlMs) {
        if (!ts || !Number.isFinite(Number(ts))) return false;
        return Date.now() - Number(ts) <= Number(ttlMs);
    }

    async function getSettings() {
        const data = await storageGet(["settings"]);
        const settings = data.settings || {};
        return { ...freshDefaults(), ...settings };
    }

    async function setSettingsPatch(patch) {
        const cur = await getSettings();
        const next = { ...cur, ...patch };
        await storageSet({ settings: next });
        return next;
    }

    // ✅ Atomic-ish mutator helper (mevcut API’yi bozmaz)
    async function updateSettings(mutator) {
        const cur = await getSettings();
        const next = { ...cur };
        try {
            if (typeof mutator === "function") mutator(next);
        } catch {
            // mutator hata atarsa yazma yapma
            return cur;
        }
        await storageSet({ settings: next });
        return next;
    }

    async function setDomainOverride(host, currencyOrNull) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const map = cloneObj(cur.domainCurrencyOverride);

        if (!currencyOrNull) delete map[host];
        else map[host] = String(currencyOrNull).trim().toUpperCase();

        return setSettingsPatch({ domainCurrencyOverride: map });
    }

    async function addCustomSelector(host, selector) {
        host = normHost(host);
        if (!host) return getSettings();
        const sel = sanitizeSelector(selector);
        if (!sel) return getSettings();
        return updateSettings((s) => {
            s.customSelectorsByHost ||= {};
            const map = s.customSelectorsByHost;

            const arr = Array.isArray(map[host]) ? map[host].slice() : [];
            if (!arr.includes(sel)) arr.push(sel);

            map[host] = arr;

            if (s.siteRatesByHost && s.siteRatesByHost[host]) {
                const sr = { ...(s.siteRatesByHost || {}) };
                delete sr[host];
                s.siteRatesByHost = sr;
            }
        });
    }

    async function removeCustomSelector(host, selector) {
        host = normHost(host);
        if (!host) return getSettings();

        return updateSettings((s) => {
            s.customSelectorsByHost ||= {};
            const map = s.customSelectorsByHost;

            const arr = Array.isArray(map[host]) ? map[host].slice() : [];
            map[host] = arr.filter((s) => s !== selector);


            if (s.siteRatesByHost && s.siteRatesByHost[host]) {
                const sr = {...(s.siteRatesByHost || {})};
                delete sr[host];
                s.siteRatesByHost = sr;
            }
        });
    }

    // -----------------------------------------
    // RATE WIDGET SELECTORS (host + USD/EUR)
    // -----------------------------------------
    function getRateSelectorsFromSettings(settings, host) {
        host = normHost(host);
        if (!host) return { USD: null, EUR: null };

        const entry = settings?.rateSelectorsByHost?.[host];
        return {
            USD: entry?.USD ? String(entry.USD) : null,
            EUR: entry?.EUR ? String(entry.EUR) : null,
        };
    }

    async function getRateSelectors(host) {
        const s = await getSettings();
        return getRateSelectorsFromSettings(s, host);
    }

    // ✅ FIXED: normalize + delete empty + invalidate site cache
    async function setRateSelector(hostname, quoteCode, selectorOrNull) {
        const host = normHost(hostname);
        const code = String(quoteCode || "").trim().toUpperCase();
        if (!host) return getSettings();
        if (code !== "USD" && code !== "EUR") return getSettings();

        const sel = sanitizeSelector(selectorOrNull ? String(selectorOrNull) : "");

        return updateSettings((s) => {
            s.rateSelectorsByHost ||= {};
            const map = s.rateSelectorsByHost;

            const curHostEntry = (map[host] && typeof map[host] === "object") ? { ...map[host] } : {};
            if (sel) {
                curHostEntry[code] = sel;
            } else {
                delete curHostEntry[code];
            }

            // host entry boşsa host’u kaldır
            if (Object.keys(curHostEntry).length === 0) delete map[host];
            else map[host] = curHostEntry;

            // CRITICAL: selector değiştiyse site cache uçsun (poison/stale bypass bitirir)
            if (s.siteRatesByHost && s.siteRatesByHost[host]) {
                const sr = { ...(s.siteRatesByHost || {}) };
                delete sr[host];
                s.siteRatesByHost = sr;
            }
        });
    }

    // -------------------------------
    // LEGACY MANUAL (geriye uyumluluk)
    // -------------------------------
    async function setManualRate(from, to, rateOrNull) {
        const cur = await getSettings();
        const map = cloneObj(cur.manualRateByPair);
        const key = pairKey(from, to);

        if (!rateOrNull) delete map[key];
        else map[key] = Number(rateOrNull);

        return setSettingsPatch({ manualRateByPair: map });
    }

    function getLegacyManualRate(settings, from, to) {
        const key = pairKey(from, to);
        const r = settings?.manualRateByPair?.[key];
        return Number.isFinite(Number(r)) ? Number(r) : null;
    }

    // -----------------------------------------
    // MANUAL host + pair (TTL yok)
    // -----------------------------------------
    function getManualRateForHostFromSettings(settings, host, from, to) {
        host = normHost(host);
        if (!host) return null;

        const key = pairKey(from, to);
        const entry = settings?.manualRatesByHost?.[host]?.pairs?.[key];
        const r = entry?.rate ?? entry;
        return Number.isFinite(Number(r)) ? Number(r) : null;
    }

    async function getManualRateForHost(host, from, to) {
        host = normHost(host);
        if (!host) return null;

        const s = await getSettings();
        return getManualRateForHostFromSettings(s, host, from, to);
    }

    async function setManualRateForHost(host, from, to, rateOrNull) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const allHosts = cloneObj(cur.manualRatesByHost);

        const hostEntry = allHosts[host] ? { ...allHosts[host] } : { pairs: {} };
        const pairs = cloneObj(hostEntry.pairs);

        const key = pairKey(from, to);

        if (!rateOrNull) {
            delete pairs[key];
        } else {
            pairs[key] = { rate: Number(rateOrNull), ts: Date.now() };
        }

        hostEntry.pairs = pairs;
        allHosts[host] = hostEntry;

        return setSettingsPatch({ manualRatesByHost: allHosts });
    }

    // -----------------------------------------
    // MANUAL host + çoklu pair TEK write
    // -----------------------------------------
    async function setManualRatesForHost(host, pairRateMap) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const allHosts = cloneObj(cur.manualRatesByHost);

        const hostEntry = allHosts[host] ? { ...allHosts[host] } : { pairs: {} };
        const pairs = cloneObj(hostEntry.pairs);

        const ts = Date.now();
        const src = (pairRateMap && typeof pairRateMap === "object") ? pairRateMap : {};

        for (const [kRaw, vRaw] of Object.entries(src)) {
            const k = String(kRaw || "").trim();
            if (!k) continue;

            const v = Number(vRaw);
            if (!Number.isFinite(v) || v <= 0) {
                delete pairs[k];
            } else {
                pairs[k] = { rate: v, ts };
            }
        }

        hostEntry.pairs = pairs;
        allHosts[host] = hostEntry;

        return setSettingsPatch({ manualRatesByHost: allHosts });
    }

    // -----------------------------------------
    // PINNED host + pair (TTL yok)
    // -----------------------------------------
    function getPinnedRateForHostFromSettings(settings, host, from, to) {
        host = normHost(host);
        if (!host) return null;

        const key = pairKey(from, to);
        const entry = settings?.pinnedRatesByHost?.[host]?.pairs?.[key];
        if (!entry) return null;

        const r = entry?.rate ?? entry;
        if (!Number.isFinite(Number(r)) || Number(r) <= 0) return null;

        return {
            rate: Number(r),
            confidence: typeof entry?.confidence === "number" ? entry.confidence : 1.0,
            evidence: entry?.evidence || "pinned",
            nSamples: entry?.nSamples,
            dispersion: entry?.dispersion,
            ts: entry?.tsPinned || entry?.ts || null,
        };
    }

    async function getPinnedRateForHost(host, from, to) {
        host = normHost(host);
        if (!host) return null;

        const s = await getSettings();
        return getPinnedRateForHostFromSettings(s, host, from, to);
    }

    async function setPinnedRateForHost(host, from, to, rateOrEntryOrNull) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const allHosts = cloneObj(cur.pinnedRatesByHost);

        const hostEntry = allHosts[host] ? { ...allHosts[host] } : { pairs: {} };
        const pairs = cloneObj(hostEntry.pairs);

        const key = pairKey(from, to);

        if (!rateOrEntryOrNull) {
            delete pairs[key];
        } else if (typeof rateOrEntryOrNull === "number") {
            pairs[key] = {
                rate: Number(rateOrEntryOrNull),
                confidence: 1.0,
                evidence: "pinned",
                tsPinned: Date.now(),
            };
        } else {
            pairs[key] = {
                rate: Number(rateOrEntryOrNull.rate),
                confidence: typeof rateOrEntryOrNull.confidence === "number" ? rateOrEntryOrNull.confidence : 1.0,
                evidence: rateOrEntryOrNull.evidence || "pinned",
                nSamples: rateOrEntryOrNull.nSamples,
                dispersion: rateOrEntryOrNull.dispersion,
                tsPinned: Date.now(),
            };
        }

        hostEntry.pairs = pairs;
        allHosts[host] = hostEntry;

        return setSettingsPatch({ pinnedRatesByHost: allHosts });
    }

    // -----------------------------------------
    // SITE DETECT cache (TTL var)
    // -----------------------------------------
    function getSitePairsForHostFromSettings(settings, host, allowStale = false) {
        host = normHost(host);
        if (!host) return null;

        const entry = settings?.siteRatesByHost?.[host];
        if (!entry || !entry.pairs) return null;

        const ttl = settings?.siteRateTtlMs ?? freshDefaults().siteRateTtlMs;
        if (allowStale) return entry.pairs;

        if (!isFresh(entry.ts, ttl)) return null;
        return entry.pairs;
    }

    async function getSitePairsForHost(host, allowStale = false) {
        host = normHost(host);
        if (!host) return null;

        const s = await getSettings();
        return getSitePairsForHostFromSettings(s, host, allowStale);
    }

    async function setSitePairsForHost(host, pairs) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const map = cloneObj(cur.siteRatesByHost);

        map[host] = {
            ts: Date.now(),
            pairs: pairs || {},
        };

        return setSettingsPatch({ siteRatesByHost: map });
    }

    async function clearSitePairsForHost(host) {
        host = normHost(host);
        if (!host) return getSettings();

        const cur = await getSettings();
        const map = cloneObj(cur.siteRatesByHost);
        delete map[host];
        return setSettingsPatch({ siteRatesByHost: map });
    }

    // -----------------------------------------
    // RATE SEÇİMİ helper
    // Öncelik: PINNED > MANUAL_HOST > SITE(conf+nSamples+disp) > LEGACY
    // -----------------------------------------
    function pickBestRateFromSettings(settings, host, from, to, opts = {}) {
        host = normHost(host);
        if (!host) return null;

        function getRateMode(settingsObj, hostKey, pair) {
            const entry = settingsObj?.rateModeByHost?.[hostKey];
            const mode = entry?.[pair];
            return mode === "AUTO" || mode === "MANUAL" ? mode : null;
        }
        function sccDbg(...a) {
            if (globalThis.SCC_DEBUG) console.log("[SCC]", ...a);
        }

        const minConf = typeof opts.minConf === "number" ? opts.minConf : 0.70;
        const minSamples = typeof opts.minSamples === "number" ? opts.minSamples : 3;
        const maxDisp = typeof opts.maxDisp === "number" ? opts.maxDisp : 0.03;

        const reqKey = pairKey(from, to);
        const invKey = pairKey(to, from);
        const modeReq = getRateMode(settings, host, reqKey);
        const modeInv = getRateMode(settings, host, invKey);
        const manualAllowed = modeReq !== "AUTO" && modeInv !== "AUTO";

        // 1) manual host
        if (manualAllowed) {
            const m = getManualRateForHostFromSettings(settings, host, from, to);
            if (m != null) {
                sccDbg("pickBestRate: manual direct", { host, from, to, usedKey: reqKey, inverted: false, rate: m });
                return { rate: m, confidence: 1.0, evidence: "manual", source: "MANUAL_HOST" };
            }
            const mInv = getManualRateForHostFromSettings(settings, host, to, from);
            if (mInv != null && Number(mInv) > 0) {
                sccDbg("pickBestRate: manual inverted", { host, from, to, usedKey: invKey, inverted: true, rate: mInv });
                return { rate: 1 / Number(mInv), confidence: 1.0, evidence: "manual+inv", source: "MANUAL_HOST" };
            }
        } else {
            sccDbg("pickBestRate: manual skipped (AUTO mode)", {
                host,
                from,
                to,
                usedKey: modeReq === "AUTO" ? reqKey : invKey
            });
        }

        const pinned = getPinnedRateForHostFromSettings(settings, host, from, to);
        if (pinned) {
            sccDbg("pickBestRate: pinned direct", { host, from, to, usedKey: reqKey, inverted: false, rate: pinned.rate });
            return { ...pinned, source: "PINNED" };
        }

        const pinnedInv = getPinnedRateForHostFromSettings(settings, host, to, from);
        if (pinnedInv && Number(pinnedInv.rate) > 0) {
            sccDbg("pickBestRate: pinned inverted", { host, from, to, usedKey: invKey, inverted: true, rate: pinnedInv.rate });
            return {
                ...pinnedInv,
                rate: 1 / Number(pinnedInv.rate),
                evidence: (pinnedInv.evidence || "pinned") + "+inv",
                source: "PINNED",
            };
        }

        // 3) site
        const sitePairs = getSitePairsForHostFromSettings(settings, host, false) || null;
        if (sitePairs) {

            const direct = sitePairs[reqKey];

            if (direct && Number.isFinite(Number(direct.rate)) && Number(direct.rate) > 0) {
                const conf = typeof direct.confidence === "number" ? direct.confidence : 0;
                const ns = Number(direct.nSamples ?? 0);
                const disp = Number(direct.dispersion ?? 1);

                if (conf >= minConf && ns >= minSamples && disp <= maxDisp) {
                    sccDbg("pickBestRate: site direct", { host, from, to, usedKey: reqKey, inverted: false, rate: direct.rate });
                    return { ...direct, rate: Number(direct.rate), source: "SITE" };
                }
            }

            const inv = sitePairs[invKey];

            if (inv && Number.isFinite(Number(inv.rate)) && Number(inv.rate) > 0) {
                const conf = typeof inv.confidence === "number" ? inv.confidence : 0;
                const ns = Number(inv.nSamples ?? 0);
                const disp = Number(inv.dispersion ?? 1);

                if (conf >= minConf && ns >= minSamples && disp <= maxDisp) {
                    sccDbg("pickBestRate: site inverted", { host, from, to, usedKey: invKey, inverted: true, rate: inv.rate });
                    return {
                        ...inv,
                        rate: 1 / Number(inv.rate),
                        evidence: (inv.evidence || "site") + "+inv",
                        source: "SITE",
                    };
                }
            }
        }

        // 4) legacy
        const legacy = getLegacyManualRate(settings, from, to);

        if (legacy != null) {
            sccDbg("pickBestRate: legacy direct", { host, from, to, usedKey: reqKey, inverted: false, rate: legacy });
            return { rate: legacy, confidence: 1.0, evidence: "legacy-manual", source: "MANUAL_LEGACY" };
        }

        const legacyInv = getLegacyManualRate(settings, to, from);
        if (legacyInv != null && Number(legacyInv) > 0) {
            sccDbg("pickBestRate: legacy inverted", { host, from, to, usedKey: invKey, inverted: true, rate: legacyInv });
            return { rate: 1 / Number(legacyInv), confidence: 1.0, evidence: "legacy-manual+inv", source: "MANUAL_LEGACY" };
        }

        return null;
    }

    globalThis.SCCStorage = {
        // mevcut API
        getSettings,
        setSettingsPatch,
        updateSettings, //

        setDomainOverride,
        addCustomSelector,
        removeCustomSelector,
        setManualRate, // legacy

        // yeni API
        safeHostFromUrl,
        normHost,

        // rate selectors
        getRateSelectors,
        setRateSelector,

        getManualRateForHost,
        setManualRateForHost,
        setManualRatesForHost,

        getPinnedRateForHost,
        setPinnedRateForHost,

        getSitePairsForHost,
        setSitePairsForHost,
        clearSitePairsForHost,

        // helper
        pickBestRateFromSettings,
    };
})();
