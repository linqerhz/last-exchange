(() => {
    const SOURCE_CURRENCIES = [
        "RUB","UAH","KZT","TRY","EUR","BYN","GBP","RON","PLN","UZS","KGS","DKK","MDL","CZK","BGN","HUF","AED","USD"
    ];

    const TARGET_CURRENCIES = ["EUR","USD","ORIGINAL"];

    // Bazı semboller/tokenlar belirsiz: confidence düşürmek için işaretliyoruz
    const AMBIGUOUS_SYMBOLS = new Set(["$", "DH", "kr"]);

    // Sembol -> kod adayları (bizim hedef setimiz dahilinde)
    const SYMBOL_TO_CODES = {
        "€": ["EUR"],
        "£": ["GBP"],
        "￡": ["GBP"],
        "₽": ["RUB"],
        "₴": ["UAH"],
        "₸": ["KZT"],
        "₺": ["TRY"],
        "TL": ["TRY"],
        "TL.": ["TRY"],
        "د.إ": ["AED"],
        "DH": ["AED"],         // belirsiz olabilir (o yüzden AMBIGUOUS)
        "$": ["USD"],
        "＄": ["USD"], // belirsiz olabilir (o yüzden AMBIGUOUS)
        "zł": ["PLN"],
        "zł.": ["PLN"],
        "zl": ["PLN"],         // ASCII yazım
        "zl.": ["PLN"],
        "kr": ["DKK"]          // belirsiz olabilir (o yüzden AMBIGUOUS)
    };

    const CODE_TOKENS = SOURCE_CURRENCIES.slice();

    const TLD_TO_CURRENCY = {
        "ru": "RUB",
        "ua": "UAH",
        "kz": "KZT",
        "tr": "TRY",
        "by": "BYN",
        "uk": "GBP",
        "gb": "GBP",
        "ro": "RON",
        "pl": "PLN",
        "uz": "UZS",
        "kg": "KGS",
        "dk": "DKK",
        "md": "MDL",
        "cz": "CZK",
        "bg": "BGN",
        "hu": "HUF",
        "ae": "AED"
    };

    // Text token -> currency (hepsi lowercase tutulacak)
    // NOT: bunları detect tarafında word-boundary ile kullanacağız
    const TEXT_HINTS = {
        "руб": "RUB",
        "руб.": "RUB",
        "грн": "UAH",
        "грн.": "UAH",
        "тенге": "KZT",
        "тг": "KZT",

        "tl": "TRY",

        "uah": "UAH",
        "rub": "RUB",
        "kzt": "KZT",
        "pln": "PLN",
        "czk": "CZK",
        "huf": "HUF",
        "ron": "RON",
        "aed": "AED",
        "dkk": "DKK",
        "mdl": "MDL",
        "kgs": "KGS",
        "uzs": "UZS",
        "byn": "BYN",

        "zł": "PLN",
        "zl": "PLN"
    };

    // --- küçük yardımcılar (detect tarafı bunları kullanabilir) ---
    function normalizeText(s) {
        return String(s || "")
            .replace(/\u00A0/g, " ")   // NBSP
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase()
            // Polonya ł -> l (zł/os. gibi yerlerde ascii arama için)
            .replace(/ł/g, "l");
    }

    function getTldCurrency(hostname) {
        const h = normalizeText(hostname).replace(/^www\./, "");
        const parts = h.split(".").filter(Boolean);
        const tld = parts[parts.length - 1] || "";
        return TLD_TO_CURRENCY[tld] || null;
    }

    function getCodesForSymbol(sym) {
        const key = normalizeText(sym);
        // normalizeText ł->l yaptığı için zł -> zl olabilir; ikisini de mapledik zaten
        return SYMBOL_TO_CODES[key] || SYMBOL_TO_CODES[sym] || null;
    }

    function isAmbiguousSymbol(sym) {
        return AMBIGUOUS_SYMBOLS.has(sym) || AMBIGUOUS_SYMBOLS.has(normalizeText(sym));
    }

    globalThis.SCC_MAPS = {
        SOURCE_CURRENCIES,
        TARGET_CURRENCIES,
        SYMBOL_TO_CODES,
        CODE_TOKENS,
        TLD_TO_CURRENCY,
        TEXT_HINTS,
        AMBIGUOUS_SYMBOLS,

        // helpers
        normalizeText,
        getTldCurrency,
        getCodesForSymbol,
        isAmbiguousSymbol
    };
})();
