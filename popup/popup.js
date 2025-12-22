// popup/popup.js
(async () => {
    function sendTabMessage(tabId, msg) {
        return new Promise((resolve) => chrome.tabs.sendMessage(tabId, msg, resolve));
    }

    function getActiveTab() {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null));
        });
    }

    function hostFromUrl(url) {
        try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
    }

    function normHostLocal(h) {
        return String(h || "").trim().toLowerCase().replace(/^www\./, "");
    }

    function hostKeyFromHost(host) {
        const norm = globalThis.SCCStorage?.normHost;
        return typeof norm === "function" ? norm(host) : normHostLocal(host);
    }

    const elDetected = document.getElementById("detected");
    const elHost = document.getElementById("host");
    const elTarget = document.getElementById("target");
    const elOverride = document.getElementById("override");
    const elSelector = document.getElementById("selector");
    const elSelectorsList = document.getElementById("selectorsList");
    const elManualRate = document.getElementById("manualRate");

    const btnRefresh = document.getElementById("refresh");
    const btnConvert = document.getElementById("convert");
    const btnRevert = document.getElementById("revert");
    const btnAddSelector = document.getElementById("addSelector");
    const btnSaveManual = document.getElementById("saveManual");

    // Scope picker buttons (mevcut)
    const btnPickerStart = document.getElementById("pickerStart");
    const btnPickerStop = document.getElementById("pickerStop");

    // (opsiyonel) site cache temizleme
    const btnClearSiteCache = document.getElementById("clearSiteCache");

    // ✅ Rate selectors UI (opsiyonel)
    // input#rateSelUsd, input#rateSelEur, button#saveRateSelectors
    const elRateSelUsd = document.getElementById("rateSelUsd");
    const elRateSelEur = document.getElementById("rateSelEur");
    const btnSaveRateSelectors = document.getElementById("saveRateSelectors");

    // ✅ Rate picker buttons (opsiyonel) - popup.html'e eklersen çalışır
    // button#ratePickUsd, button#ratePickEur, button#ratePickStop
    const btnRatePickUsd = document.getElementById("ratePickUsd");
    const btnRatePickEur = document.getElementById("ratePickEur");
    const btnRatePickStop = document.getElementById("ratePickStop");

    const elStatus = document.getElementById("status");

    function showStatus(msg, isWarn = false) {
        if (!elStatus) return;
        elStatus.textContent = msg;
        elStatus.classList.toggle("warn", !!isWarn);
        elStatus.style.display = "block";
        clearTimeout(showStatus._t);
        showStatus._t = setTimeout(() => { elStatus.style.display = "none"; }, 1700);
    }

    function setBusy(isBusy, labelConvert) {
        if (btnRefresh) btnRefresh.disabled = isBusy;
        if (btnConvert) btnConvert.disabled = isBusy;
        if (btnRevert) btnRevert.disabled = isBusy;
        if (btnAddSelector) btnAddSelector.disabled = isBusy;
        if (btnSaveManual) btnSaveManual.disabled = isBusy;

        if (btnPickerStart) btnPickerStart.disabled = isBusy;
        if (btnPickerStop) btnPickerStop.disabled = isBusy;

        if (btnClearSiteCache) btnClearSiteCache.disabled = isBusy;

        if (btnSaveRateSelectors) btnSaveRateSelectors.disabled = isBusy;

        if (btnRatePickUsd) btnRatePickUsd.disabled = isBusy;
        if (btnRatePickEur) btnRatePickEur.disabled = isBusy;
        if (btnRatePickStop) btnRatePickStop.disabled = isBusy;

        if (elTarget) elTarget.disabled = isBusy;
        if (elOverride) elOverride.disabled = isBusy;

        if (elRateSelUsd) elRateSelUsd.disabled = isBusy;
        if (elRateSelEur) elRateSelEur.disabled = isBusy;

        if (btnConvert) btnConvert.textContent = labelConvert != null ? labelConvert : "Convert";
    }

    function formatSelectorsList(sels) {
        if (!Array.isArray(sels) || sels.length === 0) return "Selectors: none";
        const maxShow = 2;
        const shown = sels.slice(0, maxShow).join(", ");
        const more = sels.length > maxShow ? ` …(+${sels.length - maxShow})` : "";
        return `Selectors: ${sels.length} (${shown}${more})`;
    }

    function formatSiteRatesSummary(siteEntry) {
        if (!siteEntry || !siteEntry.pairs) return "Site rates: (no cache)";
        const keys = Object.keys(siteEntry.pairs || {});
        if (!keys.length) return "Site rates: none";

        const top = keys
            .map(k => ({ k, v: siteEntry.pairs[k] || {} }))
            .sort((a, b) => Number(b.v.confidence || 0) - Number(a.v.confidence || 0))
            .slice(0, 3)
            .map(x => {
                const r = Number(x.v.rate || 0);
                const c = Number(x.v.confidence || 0).toFixed(2);
                const n = Number(x.v.nSamples || 0);
                const d = Number(x.v.dispersion || 0).toFixed(3);
                return `${x.k}=${r ? r.toFixed(6) : "?"}(c${c} n${n} d${d})`;
            });

        return `Site rates: ${keys.length} | ${top.join(" • ")}`;
    }

    async function getRateSelectorsForHost(hostKey) {
        const h = hostKeyFromHost(hostKey);
        if (typeof SCCStorage.getRateSelectors === "function") {
            return await SCCStorage.getRateSelectors(h);
        }
        const settings = await SCCStorage.getSettings();
        const entry = settings?.rateSelectorsByHost?.[h] || null;
        return entry && typeof entry === "object" ? entry : { USD: "", EUR: "" };
    }

    async function setRateSelectorForHost(hostKey, code, selectorOrNull) {
        const h = hostKeyFromHost(hostKey);
        const c = String(code || "").trim().toUpperCase();
        const sel = selectorOrNull ? String(selectorOrNull).trim() : "";

        if (typeof SCCStorage.setRateSelector === "function") {
            await SCCStorage.setRateSelector(h, c, sel || null);
            return;
        }

        // fallback: settings patch
        const cur = await SCCStorage.getSettings();
        const map = (cur.rateSelectorsByHost && typeof cur.rateSelectorsByHost === "object")
            ? { ...cur.rateSelectorsByHost }
            : {};

        const hostEntry = (map[h] && typeof map[h] === "object") ? { ...map[h] } : {};
        if (!sel) delete hostEntry[c];
        else hostEntry[c] = sel;

        map[h] = hostEntry;
        await SCCStorage.setSettingsPatch({ rateSelectorsByHost: map });
    }

    // fill override list (once)
    if (elOverride) {
        elOverride.innerHTML = `<option value="">(no override)</option>`;
        for (const c of (globalThis.SCC_MAPS?.SOURCE_CURRENCIES || [])) {
            const opt = document.createElement("option");
            opt.value = c;
            opt.textContent = c;
            elOverride.appendChild(opt);
        }
    }

    const tab = await getActiveTab();
    const hostRaw = tab ? hostFromUrl(tab.url) : "";
    const hostKey = hostKeyFromHost(hostRaw);

    if (elHost) elHost.textContent = hostRaw ? hostRaw : "No active tab";

    async function refreshUI() {
        const settings = await SCCStorage.getSettings();

        if (elTarget) elTarget.value = settings.targetCurrency || "EUR";

        if (elOverride) {
            const ov = settings.domainCurrencyOverride?.[hostKey] || "";
            elOverride.value = ov;
        }

        const sels = settings.customSelectorsByHost?.[hostKey] || [];
        const siteEntry = settings.siteRatesByHost?.[hostKey] || null;

        const text1 = formatSelectorsList(sels);
        const text2 = formatSiteRatesSummary(siteEntry);

        if (elSelectorsList) elSelectorsList.textContent = `${text1} | ${text2}`;

        // rate selectors inputs doldur (popup.html'e ekliyse)
        if (elRateSelUsd || elRateSelEur) {
            const rs = await getRateSelectorsForHost(hostKey);
            if (elRateSelUsd) elRateSelUsd.value = rs?.USD || "";
            if (elRateSelEur) elRateSelEur.value = rs?.EUR || "";
        }

        if (!tab?.id) {
            if (elDetected) elDetected.textContent = "no tab";
            return;
        }

        const resp = await sendTabMessage(tab.id, { type: "DETECT" });
        if (resp?.ok) {
            const d = resp.detection || {};
            if (elDetected) {
                elDetected.textContent = d.currency
                    ? `${d.currency} (conf ${Math.round((d.confidence || 0) * 100)}% • ${d.evidence || "signal"})`
                    : "not detected";
            }
        } else {
            if (elDetected) elDetected.textContent = "content script not available on this page";
        }
    }

    if (btnRefresh) {
        btnRefresh.onclick = async () => {
            setBusy(true);
            try {
                await refreshUI();
                showStatus("Refreshed.");
            } finally {
                setBusy(false);
            }
        };
    }

    if (elTarget) {
        elTarget.onchange = async () => {
            await SCCStorage.setSettingsPatch({ targetCurrency: elTarget.value });
            showStatus("Target saved.");
        };
    }

    if (elOverride) {
        elOverride.onchange = async () => {
            if (!hostKey) return;
            setBusy(true);
            try {
                await SCCStorage.setDomainOverride(hostKey, elOverride.value || null);
                await refreshUI();
                showStatus("Override saved.");
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnConvert) {
        btnConvert.onclick = async () => {
            if (!tab?.id) return;

            const target = (elTarget?.value || "EUR").trim() || "EUR";

            setBusy(true, "Working…");
            try {
                const resp = await sendTabMessage(tab.id, { type: "CONVERT", target });

                if (!resp?.ok) {
                    showStatus(resp?.error || "convert failed", true);
                    return;
                }

                const n = resp.converted || 0;
                const src = resp.rateSource ? ` • ${resp.rateSource}` : "";
                const rr = resp.retried ? " • retried" : "";

                if (n === 0) showStatus(`No prices converted${rr}${src}`, true);
                else showStatus(`Converted: ${n}${rr}${src}`);

                await refreshUI();
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnRevert) {
        btnRevert.onclick = async () => {
            if (!tab?.id) return;

            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "REVERT" });
                if (!resp?.ok) showStatus(resp?.error || "revert failed", true);
                else showStatus(`Reverted: ${resp.reverted || 0}`);
                await refreshUI();
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnAddSelector) {
        btnAddSelector.onclick = async () => {
            if (!hostKey) return;

            const s = (elSelector?.value || "").trim();
            if (!s) {
                showStatus("Selector is empty.", true);
                return;
            }

            setBusy(true);
            try {
                await SCCStorage.addCustomSelector(hostKey, s);
                if (elSelector) elSelector.value = "";
                await refreshUI();
                showStatus("Selector saved.");
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnSaveManual) {
        btnSaveManual.onclick = async () => {
            const v = Number(String(elManualRate?.value || "").trim());
            if (!isFinite(v) || v <= 0) {
                showStatus("Invalid rate.", true);
                return;
            }

            if (!tab?.id) return;

            setBusy(true);
            try {
                const det = await sendTabMessage(tab.id, { type: "DETECT" });
                const from = det?.detection?.currency;
                const to = (elTarget?.value || "EUR").trim() || "EUR";

                if (!from || to === "ORIGINAL") {
                    showStatus("Need detected FROM and a real target.", true);
                    return;
                }

                if (typeof SCCStorage.setManualRateForHost === "function") {
                    await SCCStorage.setManualRateForHost(hostKey, from, to, v);
                    showStatus(`Saved manual: ${hostKey} ${from}->${to}`);
                } else {
                    await SCCStorage.setManualRate(from, to, v);
                    showStatus(`Saved manual (legacy): ${from}->${to}`);
                }

                await refreshUI();
            } finally {
                setBusy(false);
            }
        };
    }

    // ✅ rate widget selectors save (input ile manuel)
    if (btnSaveRateSelectors) {
        btnSaveRateSelectors.onclick = async () => {
            if (!hostKey) return;

            const usdSel = (elRateSelUsd?.value || "").trim();
            const eurSel = (elRateSelEur?.value || "").trim();

            setBusy(true);
            try {
                await setRateSelectorForHost(hostKey, "USD", usdSel || null);
                await setRateSelectorForHost(hostKey, "EUR", eurSel || null);
                await refreshUI();
                showStatus("Rate widget selectors saved.");
            } catch (e) {
                showStatus(String(e?.message || e), true);
            } finally {
                setBusy(false);
            }
        };
    }

    // ✅ Rate picker controls: content.js START_RATE_PICKER / STOP_RATE_PICKER
    if (btnRatePickUsd) {
        btnRatePickUsd.onclick = async () => {
            if (!tab?.id) return;
            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "START_RATE_PICKER", quoteCode: "USD" });
                if (!resp?.ok) {
                    showStatus(resp?.error || "Rate picker USD failed.", true);
                    return;
                }
                showStatus("Rate picker USD active. Click the USD rate line (ESC to exit).");
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnRatePickEur) {
        btnRatePickEur.onclick = async () => {
            if (!tab?.id) return;
            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "START_RATE_PICKER", quoteCode: "EUR" });
                if (!resp?.ok) {
                    showStatus(resp?.error || "Rate picker EUR failed.", true);
                    return;
                }
                showStatus("Rate picker EUR active. Click the EUR rate line (ESC to exit).");
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnRatePickStop) {
        btnRatePickStop.onclick = async () => {
            if (!tab?.id) return;
            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "STOP_RATE_PICKER" });
                if (!resp?.ok) {
                    showStatus(resp?.error || "Rate picker stop failed.", true);
                    return;
                }
                showStatus("Rate picker stopped.");
            } finally {
                setBusy(false);
            }
        };
    }

    // Scope picker controls (mevcut)
    if (btnPickerStart) {
        btnPickerStart.onclick = async () => {
            if (!tab?.id) return;
            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "START_PICKER" });
                if (!resp?.ok) {
                    showStatus(resp?.error || "Picker failed.", true);
                    return;
                }
                showStatus("Picker active. Click a price area on the page (ESC to exit).");
            } finally {
                setBusy(false);
            }
        };
    }

    if (btnPickerStop) {
        btnPickerStop.onclick = async () => {
            if (!tab?.id) return;
            setBusy(true);
            try {
                const resp = await sendTabMessage(tab.id, { type: "STOP_PICKER" });
                if (!resp?.ok) {
                    showStatus(resp?.error || "Stop failed.", true);
                    return;
                }
                showStatus("Picker stopped.");
            } finally {
                setBusy(false);
            }
        };
    }

    // (opsiyonel) cache temizleme
    if (btnClearSiteCache) {
        btnClearSiteCache.onclick = async () => {
            if (!hostKey) return;
            setBusy(true);
            try {
                await SCCStorage.clearSitePairsForHost(hostKey);
                await refreshUI();
                showStatus("Site cache cleared.");
            } finally {
                setBusy(false);
            }
        };
    }

    await refreshUI();
})();
