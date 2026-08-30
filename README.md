# 🦊 goupil

> *Goupil* : le nom du renard en ancien français — celui qui se faufile sans se faire remarquer et rapporte ce qu'on lui demande.

Stealth browser fetch **as a service** : tu lui donnes une URL, il te rend le
HTML de la page **après rendu JavaScript**, via [Camoufox](https://camoufox.com)
(Firefox anti-détection, `humanize: true`). Agnostique : le service ne connaît
aucune app consommatrice et ne parse rien — les appelants font leur propre
extraction.

Tourne sur **Netlify Functions** (free tier) — avec une vraie limite apprise à
la dure, voir « Moteurs » ci-dessous.

## Moteurs (`engine`, par requête)

- **`plain`** — fetch HTTP direct (headers réalistes, redirects suivis,
  timeout 25 s), **sans navigateur**. Tourne partout, Netlify inclus. Suffit
  dès que le site embarque sa donnée (JSON-LD / OpenGraph) dans le HTML
  initial — très courant : c'est leur SEO.
- **`browser`** (défaut) — rendu JavaScript complet via Camoufox.
  ⚠️ **Ne peut pas fonctionner sur Netlify Functions** : l'archive Camoufox
  pèse 663 Mo, le `/tmp` d'une Lambda est plafonné à **512 Mo** et Netlify
  n'expose aucun réglage pour l'augmenter (AWS le permet jusqu'à 10 Go, mais
  pas au travers de Netlify). Les Edge Functions sont pires encore (bundle
  20 Mo, 50 ms de CPU, pas de sous-processus). Ce moteur exige un hôte avec
  du vrai disque : Docker/VM (Fly.io & co).

## API

```
POST /fetch
Headers:  x-api-key: <API_KEY>
          content-type: application/json
Body:     { "url": "https://www.example.com/page", "engine": "plain" }   engine optionnel : "browser" (défaut) | "plain"

200 → { "html": "<!doctype html>…" }
400 → { "error": "invalid_url" | "invalid_body" }     URL absente, >2048 chars, ou hôte interdit (SSRF)
401 → { "error": "unauthorized" }                     mauvaise clé
405 → { "error": "method_not_allowed" }
502 → { "error": "fetch_failed", "detail": "…" }      le navigateur n'a pas pu rendre la page
503 → { "error": "service_not_configured" }           API_KEY non posée côté serveur
```

Garde SSRF intégrée : refus des IP privées/réservées/loopback/link-local
(métadonnées cloud incluses), des littéraux IPv4 obscurcis, et des hôtes
publics qui **résolvent** vers une adresse interne.

## API — `POST /extract` (extraction structurée, sans LLM)

Même rendu Camoufox, puis extraction **100 % déterministe** (zéro coût par
appel) de la donnée structurée que les sites embarquent déjà :

```
POST /extract
Headers:  x-api-key, content-type: application/json
Body:     { "url": "https://…", "rules": { … }, "engine": "plain" }     rules et engine optionnels

200 → {
  "auto": {                        // toujours renvoyé, zéro configuration
    "meta":   { "og:title": "…", "og:image": "…", … },   // toutes les <meta>
    "jsonld": [ { "@type": "Hotel", "name": "…", … } ],  // schema.org parsé (@graph aplati)
    "images": [ "https://…jpg?…" ]                       // URLs d'images dédupliquées (max 50)
  },
  "data": { … }                    // seulement si rules fourni
}
```

`rules` dit **où** chercher, champ par champ — le service connaît des
mécanismes, jamais des plateformes :

```jsonc
{
  "name":   { "meta": "og:title" },
  "hotel":  { "jsonld": "Hotel.name" },                  // "Type.chemin.champ", "*" = tout type
  "ville":  { "jsonld": "Hotel.address.addressLocality" },
  "note":   { "jsonld": "*.aggregateRating.ratingValue" },
  "photos": { "regex": "https://[a-z0-9.-]+\\.trvl-media\\.com/[^\"\\s]+", "all": true }
}
```

Les URLs échappées en JSON (`https:\/\/…`) sont matchées, `&amp;` est décodé,
les query strings survivent entières. Pour la plupart des sites voyage/e-commerce,
le mode `auto` (OpenGraph + schema.org) suffit sans aucune règle.

### Qui déclare quoi (le contrat)

**Le profil appartient à l'app consommatrice, pas à goupil.** Chaque app
versionne son propre fichier de règles dans SON repo (à côté du code qui
consomme les champs) et l'envoie en `rules` à chaque appel — ~1-2 Ko dans le
sens app→goupil, négligeable. Ajouter un champ = un commit dans l'app, zéro
déploiement goupil. Goupil ne connaît que des **mécanismes** (meta, jsonld,
regex, chaînes de fallback), jamais les besoins d'une app.

```jsonc
// hamak/…/goupil-profile.json — versionné CHEZ l'appelant
{ "name":   [ { "jsonld": "Hotel.name" }, { "meta": "og:title" } ],
  "city":   [ { "jsonld": "*.address.addressLocality" } ],
  "rating": [ { "jsonld": "*.aggregateRating.ratingValue" } ] }

POST /extract  { "url": "https://…", "rules": <ce fichier>, "auto": ["images"] }
200 → { "auto": { "images": ["…"] },
        "data": { "name": "Villa les Oliviers", "city": "Annecy", "rating": 4.8 } }
```

- Chaque champ = une règle ou une **chaîne de fallback** (la première qui
  trouve gagne).
- `auto` contrôle le poids de la réponse : `true` (défaut, tout), `false`
  (data seul), ou un sous-ensemble `["meta"|"jsonld"|"images"]`. Le HTML,
  lui, ne quitte **jamais** le service via /extract.
- **Défauts optionnels** : `profile: "lodging"` invoque un jeu de règles
  générique embarqué (`profiles/lodging.json` — schema.org Hotel/
  VacationRental/Product + fallback OpenGraph), pratique pour tester au curl
  sans rien écrire. `rules` inline surcharge champ par champ. Inconnu →
  `400 { error: "unknown_profile", available: [...] }`. Ce n'est qu'une
  commodité — le chemin normal reste les règles envoyées par l'app.

## Déploiement (Netlify)

1. **Add new project → Import from Git** → ce repo. Les réglages viennent de
   `netlify.toml`, rien à changer.
2. **Environment variables** → ajouter `API_KEY` (générer :
   `openssl rand -base64 32`).
3. Deploy. C'est tout.

### Smoke test

```bash
curl -sS -X POST "https://<ton-site>.netlify.app/fetch" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com"}' | head -c 300
```

Attendu : `{"html":"<!doctype html>…`. Premier appel lent (cold start +
provisionnement du navigateur) ; les suivants plus rapides.

## Limites connues

- **Moteur `browser` indisponible sur l'hébergement Netlify actuel** (voir
  « Moteurs ») : Camoufox (663 Mo) ne tient physiquement pas dans le `/tmp`
  Lambda (512 Mo). Sur goupil-fetcher.netlify.app, seul `engine: "plain"`
  aboutit ; `browser` échoue en `fetch_failed` (ENOSPC). Pistes si `plain` ne
  suffit pas pour une cible : moteur Chromium serverless compressé
  (~280 Mo décompressés, tient dans 512 Mo, mais sans le stealth Camoufox),
  ou déployer ce même service en Docker sur Fly.io avec Camoufox baké dans
  l'image.
- **Timeout** : le worker interne se coupe à 85 s, mais la fenêtre d'exécution
  réelle dépend du plan/runtime Netlify (les functions synchrones ont un
  plafond bien plus bas selon les plans). Les scrapes typiques (10-25 s)
  passent ; les pires cas peuvent timeouter → l'appelant doit garder un
  fallback. Si ça devient limitant : basculer sur une background function +
  polling, ou héberger ce même repo sur une VM.
- **1 requête = 1 navigateur** : pas de pool, pas de file. Un appelant doit
  rate-limiter en amont.
- IP de sortie = celle de l'infra Netlify (US) — suffisant pour l'usage actuel.

## Consommateurs connus

- Hamak (`actions/fetch/browser.ts`, branche `SCRAPER_URL`) — parsing côté app.
