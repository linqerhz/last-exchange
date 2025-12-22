// background/sw.js
// API tamamen kapalı: background artık network fetch yapmaz.
// Sadece legacy "manualRateByPair" (host bağımsız) varsa onu döner.
// (Content.js zaten SITE/PINNED/MANUAL_HOST seçimini kendi yapıyor.)

importScripts("../lib/storage.js");

function normCode(x) {
    return String(x || "").trim().toUpperCase();
}

function isPosNum(x) {
    return Number.isFinite(Number(x)) && Number(x) > 0;
}

async function getLegacyManualRateIfAny(from, to) {
    const f = normCode(from);
    const t = normCode(to);
    const settings = await globalThis.SCCStorage.getSettings();

    const key = `${f}->${t}`;
    const r = settings?.manualRateByPair?.[key];
    if (isPosNum(r)) return Number(r);

    // inverse fallback (eski şemada ters yönde kayıt olabilir)
    const invKey = `${t}->${f}`;
    const inv = settings?.manualRateByPair?.[invKey];
    if (isPosNum(inv)) return 1 / Number(inv);

    return null;
}

async function getRateManualOnly(from, to) {
    const f = normCode(from);
    const t = normCode(to);

    if (!f || !t) throw new Error("Missing from/to");
    if (f === t) return 1;

    const legacy = await getLegacyManualRateIfAny(f, t);
    if (legacy) return legacy;

    throw new Error("API disabled. No legacy manualRateByPair found for this pair.");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (msg?.type === "PING") {
                sendResponse({ ok: true });
                return;
            }

            // Geriye dönük uyumluluk: eski kod hâlâ GET_RATE çağırırsa
            // sadece legacy manuel rate dönebilir.
            if (msg?.type === "GET_RATE") {
                const rate = await getRateManualOnly(msg.from, msg.to);
                sendResponse({ ok: true, rate, source: "MANUAL_LEGACY" });
                return;
            }

            sendResponse({ ok: false, error: "Unknown message" });
        } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
        }
    })();

    return true;
});
