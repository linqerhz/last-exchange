# last-exchange

**last-exchange** is a Chrome (MV3) extension that detects a webpage’s **base currency** and converts visible prices using the **actual exchange rates shown on that site**, not external APIs.

It is designed for **power users** working with travel, tourism, and pricing-heavy websites where site-specific exchange rates matter more than global FX rates.

---

## What this extension does

* Detects the **base currency** of the current page (e.g. RUB, EUR, USD)
* Extracts exchange rates directly from **on-page rate widgets**

    * Example:
      `USD 83.5 | EUR 100.35` → base = RUB
      USD→RUB = 83.5, EUR→RUB = 100.35
* Converts visible prices using those extracted rates
* Keeps **popup UI and page overlay UI fully synchronized**
* Works **without external FX APIs**

---

## Why this exists

Most currency extensions:

* Use generic FX APIs
* Ignore site-specific pricing logic
* Produce misleading conversions on travel and B2B sites

**last-exchange** instead trusts **what the site itself uses**.

---

## Architecture overview

### Components

* **Content Script**

    * Detects currency signals in the DOM
    * Extracts site rates
    * Renders the top page bar (overlay UI)
    * Performs conversion and revert

* **Popup (Action UI)**

    * Shows detected base currency
    * Allows:

        * Domain currency override
        * Custom price selectors
        * Rate widget selectors (USD / EUR)
        * Manual rate entry
    * Fully synced with the page UI

* **Storage (single source of truth)**

    * `chrome.storage.local`
    * Host-based state

---

## Rate source priority

Rates are always chosen using the following order:

1. **MANUAL_HOST**
   User-saved manual rate for the current host

2. **SITE_DETECTED**
   Rates parsed from the page DOM

3. **PINNED**
   User-pinned fallback rate

4. **NONE**
   No conversion possible

The active rate source is always shown in both UIs.

---

## Base currency detection

The extension attempts to detect the base currency using:

* Currency symbols
* Tokens in price elements
* Dominant currency in the selected scope

If detection fails:

* A **domain override** can be set in the popup
* Rate selectors can still work using that override

If no base can be determined, conversion is safely aborted.

---

## Safety and edge cases

* No external network calls
* No silent fallback to APIs
* No partial or misleading conversions
* If a required rate is missing:

    * Conversion is **not executed**
    * A clear message is shown:

      > “Rate not available. Set domain override, add rate selectors, or save a manual rate.”

---

## Performance considerations

* DOM parsing is memoized **per detect call**
* No global DOM cache (avoids stale data)
* Site rate cache uses TTL with silent refresh
* No repeated parsing of identical selectors

---

## Limitations (intentional)

* Not designed for casual users
* Requires understanding of:

    * Selectors
    * Site pricing structure
* DOM changes on sites may require selector updates
* Not intended to “support every site automatically”

This is a **precision tool**, not a mass-market converter.

---

## When to use this

* Travel / tourism pricing
* B2B portals
* Supplier extranets
* Sites with custom or non-standard FX logic

---

## When NOT to use this

* Simple “what’s 100 USD in EUR” needs
* Users unfamiliar with CSS selectors
* Sites without visible rate information

---

## Project status

* Core logic: **stable**
* UI sync: **stable**
* Edge cases: **handled**
* Actively usable in real scenarios

Version: **v0.9.x**


