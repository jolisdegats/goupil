"""
Scrapling (D4Vinci / Karim Shoair) face aux moteurs de goupil.

Tourne DANS l'image Docker officielle (pyd4vinci/scrapling) sur un runner CI :
même IP datacenter, même minute que les moteurs goupil mesurés juste avant
(scrapling-compare.mts fetch). Pour chaque cible et chaque mode, écrit le HTML
dans <out>/scrapling-<mode>-<cible>.html et une ligne dans <out>/results.jsonl ;
le verdict (scrapling-compare.mts verdict) passe ensuite TOUS les HTML dans le
vrai code d'extraction de goupil — mêmes règles pour tout le monde.

Modes :
  http    — Fetcher (curl_cffi, empreinte TLS/HTTP2 de Chrome) : l'équivalent
            Scrapling de nos moteurs impit/cloak.
  social  — le même Fetcher avec l'UA facebookexternalhit : notre moteur
            `social`, rejoué sur la pile réseau de Scrapling.
  stealth — StealthyFetcher (Chromium patchright + empreintes browserforge) :
            l'équivalent de notre moteur `browser`, avec capture des réponses
            XHR — la seule piste pour un prix qui n'arrive QUE par XHR.

  python scrapling-bakeoff.py <out> <cible>=<url> [<cible>=<url> ...]
"""
import json
import re
import sys
import time
from pathlib import Path

import scrapling
from scrapling.fetchers import Fetcher, StealthySession

SOCIAL_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"

# Montants en euros, ou clés de prix nommées dans un JSON (mêmes motifs que
# price-search.mjs).
PRICE = re.compile(
    r"(?:€|EUR)\s*\d[\d\s .,]{0,8}\d|\d[\d\s .,]{0,8}\d\s*(?:€|EUR)"
    r"|\"(?:grossPrice|b_raw_price|priceValue|formattedPrice|displayPrice|structuredDisplayPrice|price|amount)\"\s*:",
    re.I,
)

# Le mur d'Akamai peut se lever tout seul en 20-40 s : on lui laisse sa chance,
# comme engine-bakeoff.mjs le fait pour Camoufox et patchright.
WAIT_WALL = (
    "() => !/robot ou pas robot|bot or not|are you a robot|access denied/i.test(document.title)"
)


def wait_for_wall(page):
    try:
        page.wait_for_function(WAIT_WALL, timeout=45_000, polling=2_000)
    except Exception:
        print("    (mur toujours là après 45 s)")


def http(url):
    page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30, retries=1)
    return page, []


def social(url):
    page = Fetcher.get(
        url,
        impersonate="chrome",
        stealthy_headers=False,
        headers={"user-agent": SOCIAL_UA, "accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
        timeout=30,
        retries=1,
    )
    return page, []


def stealth(url):
    with StealthySession(
        headless=True,
        network_idle=True,
        locale="fr-FR",
        timezone_id="Europe/Paris",
        timeout=60_000,
        wait=3_000,
        page_action=wait_for_wall,
        record_requests=True,
    ) as session:
        page = session.fetch(url)
        captured = []
        for record in session.network.search(limit=None, include_static=False):
            body = record.body
            text = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
            hits = PRICE.findall(text)
            if hits:
                captured.append(
                    {
                        "url": record.url[:200],
                        "status": record.status,
                        "bytes": len(text),
                        "hits": len(hits),
                        "sample": sorted({h.strip() for h in hits})[:8],
                    }
                )
        return page, captured


MODES = {"http": http, "social": social, "stealth": stealth}


def main():
    if len(sys.argv) < 3:
        print("usage: scrapling-bakeoff.py <out> <cible>=<url> [...]", file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    targets = [arg.split("=", 1) for arg in sys.argv[2:]]
    print(f"scrapling {scrapling.__version__}")

    with (out / "results.jsonl").open("a", encoding="utf-8") as results:
        for target, url in targets:
            for mode, run in MODES.items():
                label = f"scrapling-{mode}"
                print(f"\n═══ {label} — {target}\n    {url[:130]}")
                row = {"engine": label, "target": target, "url": url}
                t0 = time.monotonic()
                try:
                    page, captured = run(url)
                    html = page.html_content
                    row.update(status=page.status, final_url=page.url, bytes=len(html), xhr_prices=captured)
                    (out / f"{label}-{target}.html").write_text(html, encoding="utf-8")
                    print(f"    HTTP {page.status} — {len(html)} octets — {page.url[:100]}")
                    if captured:
                        print(f"    XHR avec des prix : {len(captured)}")
                        for c in captured[:5]:
                            print(f"      {c['status']} {c['url'][:110]} → {c['sample'][:4]}")
                except Exception as err:  # une cible qui casse ne doit pas taire les autres
                    row["error"] = f"{type(err).__name__}: {err}"[:300]
                    print(f"    ERREUR {row['error']}")
                row["ms"] = round((time.monotonic() - t0) * 1000)
                print(f"    {row['ms']} ms")
                results.write(json.dumps(row) + "\n")
                results.flush()


if __name__ == "__main__":
    main()
