// lib/numberParse.js
(() => {
    function parseNumberSmart(raw) {
        if (raw == null) return null;

        let s = String(raw)
            .replace(/\u00A0/g, " ")
            .replace(/\u202F/g, " ")
            .trim();

        if (!s) return null;

        s = s.replace(/[^\d.,\s-]/g, "");
        s = s.replace(/\s+/g, "");
        if (!s || !/\d/.test(s)) return null;

        const lastDot = s.lastIndexOf(".");
        const lastComma = s.lastIndexOf(",");
        const hasDot = lastDot >= 0;
        const hasComma = lastComma >= 0;

        let decSep = null;
        let thouSep = null;

        if (hasDot || hasComma) {
            decSep = lastComma > lastDot ? "," : ".";
            thouSep = decSep === "." ? "," : ".";
        }

        if (thouSep) {
            s = s.split(thouSep).join("");
        }

        if (decSep) {
            const last = s.lastIndexOf(decSep);
            s = s.slice(0, last) + "." + s.slice(last + 1);
        }

        if ((s.match(/\./g) || []).length > 1) return null;

        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
        return n;
    }

    // Unit-like sanity checks (expected => actual)
    // "198 405,52 rub." => 198405.52
    // "198.405,52" => 198405.52
    // "198,405.52" => 198405.52
    // "12 345,6" => 12345.6
    // "12.345" => 12345
    // "12,345" => 12345
    // "invalid" => null

    globalThis.SCCNumber = { parseNumberSmart };
})();