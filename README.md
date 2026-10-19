# 🦊 goupil

> *Goupil* : le nom du renard en ancien français — celui qui se faufile sans se faire remarquer et rapporte ce qu'on lui demande.

Récupération de pages **as a service** : tu lui donnes une URL, il te rend le
HTML — ou directement les champs que tu demandes, extraits sans LLM. Agnostique :
le service ne connaît aucune app consommatrice ; ce sont les appelants qui
disent quoi extraire.

Tourne sur **Netlify Functions** (free tier), sans navigateur — voir
« Moteurs ».

## En bref

- **`POST /fetch`** → le HTML brut de la page.
- **`POST /extract`** → les données structurées (OpenGraph, JSON-LD,
  microdata schema.org, images) et/ou les champs demandés via des `rules` —
  extraction 100 % déterministe, zéro LLM.
- **`GET /engines`** / **`DELETE /engines?url=…`** → ce que goupil a appris
  sur quel moteur marche pour quel domaine (et l'oubli forcé).
- **7 moteurs** de récupération, du moins cher au plus cher, enchaînés
  automatiquement par défaut (`engine: "auto"`).

### Ce qui marche aujourd'hui (mesuré depuis une IP datacenter)

| Plateforme | Moteur gagnant | Ce qu'on obtient |
|---|---|---|
| Booking | `social` | fiche complète en JSON-LD (Hotel, adresse, GPS, note, photos) |
| Expedia | `cloak` | fiche complète en **microdata** schema.org (pas de JSON-LD chez Expedia) |
| Airbnb | `cloak` (ou `impit`) | 5 des 9 champs du profil lodging, dont le nom, et les photos (`social` reçoit un 403) |
| Abritel | — | 429 « Robot ou pas robot » pour tous les moteurs, navigateurs furtifs compris (page de recherche) |

- **Photos** : une fiche Booking contient ~281 photos uniques, mais seules
  ~45 appartiennent à l'hôtel — le reste vient des avis, du pied de page et
  des hébergements recommandés. Utiliser une règle `regex` bornée par `until`
  (voir « API — /extract ») pour couper avant ces blocs.
- **Prix** : **pas** extrait aujourd'hui. Sur les fiches (listing pages),
  le tarif arrive par XHR et n'est pas dans le HTML serveur (Airbnb compris,
  même avec des dates). Mesuré (workflow `scrapling`) : un navigateur qui
  **écoute ses XHR** le récupère — Expedia (réponses `graphql` avec
  `displayPrice`) et Airbnb (`StaysPdpBookItQuery` : prix par nuit, frais,
  total). Sur Airbnb, patchright nu suffit ; sur Expedia, seul le navigateur
  furtif de [Scrapling](https://github.com/D4Vinci/Scrapling) passe Akamai
  (patchright nu : 429). Coût : Python + Chromium (~1,1 Go), 10 à 70 s par
  page — hors de portée d'une function Netlify, il faudrait un hôte
  conteneurisé. Autre piste (workflows `price-*`) : les **pages de
  recherche** Expedia contiennent des montants dans le HTML (reste à les
  rattacher au bon hôtel).

## Moteurs (`engine`, par requête)

Contre-intuitif mais **mesuré** : le moteur le moins cher est souvent celui qui
obtient le plus. Sur Booking, un navigateur furtif complet (Camoufox, 663 Mo,
~15 s) rend *exactement* la même chose que `social` (~2 s, zéro navigateur).

- **`auto`** (défaut) — enchaîne `social` → `cloak` → `impit` → `plain`
  (→ `browser` si `GOUPIL_BROWSER=1`) (→ `managed` si `SCRAPERAPI_KEY`) et
  s'arrête au premier qui rend des données exploitables. Un 200 vide (ni
  JSON-LD ni `og:title`/`og:image`) ou un mur anti-bot ne compte pas comme un
  succès : la chaîne continue. Le moteur gagnant est **mémorisé par domaine**
  (voir « Mémoire des moteurs »).
- **`social`** — fetch en se présentant comme le crawler d'aperçu de liens de
  Facebook (sur une empreinte TLS Chrome). Ce n'est pas un déguisement
  gratuit : les sites servent **volontairement** leurs métadonnées à ces
  robots — c'est ainsi que se fabriquent les vignettes partagées. Seul moteur
  qui obtienne la fiche complète de Booking, là où un fetch ordinaire ne
  reçoit qu'une coquille vide de 4 Ko. Revers : c'est la version SEO de la
  page, sans prix.
- **`cloak`** — fetch avec empreinte navigateur **complète** via
  [httpcloak](https://www.npmjs.com/package/httpcloak) : TLS (JA3/JA4),
  HTTP/2 (l'« empreinte Akamai ») et pile TCP/IP. Seul moteur qui passe
  Akamai Bot Manager (Expedia) depuis une IP datacenter : 200 et la vraie
  page là où `impit`/`plain` reçoivent un 429 « Robot ou pas robot ».
  ~16 Mo de binaire natif Go (chargé via koffi) : tient dans une function
  Netlify — et le smoke test le vérifie sur le service déployé.
  `social` et `cloak` sont complémentaires : `cloak` reçoit la coquille vide
  de Booking, `social` le 429 d'Expedia.
- **`impit`** — fetch avec **empreinte TLS de Chrome** ([impit](https://github.com/apify/impit),
  bindings Rust, quelques Mo : serverless-friendly). Passe les murs qui 429 le
  fetch Node.
- **`plain`** — fetch HTTP direct (headers réalistes, redirects suivis,
  timeout 25 s). Suffit dès que le site embarque sa donnée dans le HTML initial.
- **`browser`** — rendu JavaScript complet via [Camoufox](https://camoufox.com)
  (Firefox anti-détection, `humanize: true`).
  ⚠️ **Indisponible sur Netlify Functions** : l'archive pèse 663 Mo, le `/tmp`
  d'une Lambda est plafonné à **512 Mo** et Netlify n'expose aucun réglage pour
  l'augmenter. Les Edge Functions sont pires (bundle 20 Mo, 50 ms de CPU, pas de
  sous-processus). Ce moteur exige un hôte avec du vrai disque — d'où
  `server.mts` (voir « Hébergement conteneurisé »). En pratique il n'a rien
  apporté de plus que `social`/`cloak` sur les cibles testées.
- **`managed`** — délégué à [ScraperAPI](https://www.scraperapi.com)
  (proxies résidentiels rotatifs + résolution des challenges). Filet de
  sécurité pour une cible qui refuserait vraiment toute IP datacenter.
  **Consomme des crédits payants** (une page protégée vaut 25-75 crédits sur un
  quota gratuit de 1000/mois) → la chaîne `auto` ne l'essaie qu'en tout
  dernier. Inerte sans `SCRAPERAPI_KEY`. Plus nécessaire pour Expedia depuis
  `cloak`.

> **Correction d'un diagnostic antérieur** : on a longtemps cru qu'Expedia
> bloquait toute IP datacenter. Mesuré depuis : le mur portait sur
> l'**empreinte transport**, pas sur l'IP — `cloak` passe.

### Mémoire des moteurs

goupil ne code en dur **aucune** connaissance de plateforme : en mode `auto`,
il retient quel moteur a réussi pour chaque domaine (`www.` ignoré) et
l'essaie en premier la fois suivante — une requête au lieu de tâtonner.

- Si le moteur mémorisé échoue (le site a changé de protection), la note est
  effacée et la chaîne complète reprend la main → ça se répare tout seul.
- Une note expire après **7 jours**, pour re-sonder périodiquement.
- Stockage : **Netlify Blobs** (store `goupil-engines`, aucune configuration)
  quand le runtime le fournit, sinon une `Map` en mémoire (local/conteneur).

## Variables d'environnement

À poser dans Netlify (Site configuration → Environment variables).

| Variable | Quoi | Rôle |
|---|---|---|
| `API_KEY` | clé **de goupil**, que tu génères | **requise** — le « mot de passe » du service : les apps appelantes l'envoient en `x-api-key`. Sans elle le service répond 503 (fail-closed). |
| `SCRAPERAPI_KEY` | clé d'un **service tiers payant** ([ScraperAPI](https://www.scraperapi.com)) | optionnelle — active le moteur `managed` et son maillon en fin de chaîne `auto`. **Non posée sur goupil-fetcher.netlify.app** : `managed` y est inerte, aucun crédit consommé. |
| `GOUPIL_BROWSER=1` | simple **interrupteur** | optionnelle — autorise le moteur `browser` dans la chaîne `auto`. À ne poser **que** sur un hôte conteneurisé : sur une Lambda le navigateur échoue après un long téléchargement inutile. |

La mémoire des moteurs (Netlify Blobs) ne demande aucune variable.

## Hébergement conteneurisé (optionnel)

`server.mts` expose la même API (`/fetch`, `/extract`, plus `GET /` en
healthcheck) dans un simple serveur Node, pour un hôte où le navigateur est
réellement installable (Docker, VM, Render, Fly.io…) :

```bash
API_KEY=… GOUPIL_BROWSER=1 npx tsx server.mts   # écoute sur $PORT (défaut 8080)
```

Non nécessaire aujourd'hui : sur les cibles testées, le navigateur n'apporte
rien de plus que `social`/`cloak`. Pas de route `/engines` sur ce serveur.

## API

```
POST /fetch
Headers:  x-api-key: <API_KEY>
          content-type: application/json
Body:     { "url": "https://www.example.com/page", "engine": "cloak" }
          engine optionnel : "auto" (défaut) | "social" | "cloak" | "impit" | "plain" | "browser" | "managed"

200 → { "html": "<!doctype html>…" }
400 → { "error": "invalid_url" | "invalid_body" | "invalid_engine" }
                                                      URL absente, >2048 chars, hôte interdit (SSRF), moteur inconnu
401 → { "error": "unauthorized" }                     mauvaise clé
405 → { "error": "method_not_allowed" }
502 → { "error": "fetch_failed", "detail": "…" }      aucun moteur n'a rendu la page (detail = dernier échec)
503 → { "error": "service_not_configured" }           API_KEY non posée côté serveur
```

Garde SSRF intégrée : refus des IP privées/réservées/loopback/link-local
(métadonnées cloud incluses), des littéraux IPv4 obscurcis, et des hôtes
publics qui **résolvent** vers une adresse interne.

## API — `POST /extract` (extraction structurée, sans LLM)

Même récupération que `/fetch` (même `engine`, `auto` par défaut), puis
extraction **100 % déterministe** (zéro coût par appel) de la donnée
structurée que les sites embarquent déjà :

```
POST /extract
Headers:  x-api-key, content-type: application/json
Body:     { "url": "https://…", "rules": { … }, "profile": "lodging", "auto": true, "engine": "auto" }
          tout optionnel sauf url

200 → {
  "auto": {                        // toujours renvoyé, zéro configuration
    "meta":   { "og:title": "…", "og:image": "…", … },   // toutes les <meta>
    "jsonld": [ { "@type": "Hotel", "name": "…", … } ],  // schema.org parsé (@graph aplati)
    "microdata": { "name": "…", "addresslocality": "…" }, // schema.org en itemprop (Expedia)
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
  "nom":    { "microdata": "name" },                     // itemprop, 1re occurrence
  "photos": { "regex": "https://[a-z0-9.-]+\\.trvl-media\\.com/[^\"\\s]+", "all": true },
  "galerie":{ "regex": "https://cf\\.bstatic\\.com/[^\"\\s]+\\.jpg", "all": true,
              "until": "<motif du bloc « recommandés »>" }  // ne cherche qu'AVANT ce motif
}
```

Types de règles : `meta`, `jsonld`, `microdata`, `regex` (+ `flags`, `all`
pour toutes les occurrences dédupliquées — max 50, `until` pour borner la
recherche ; un `until` absent de la page ou invalide → toute la page). 50
champs max par requête (`400 too_many_rules`), `rules` non-objet →
`400 invalid_rules`.

Les URLs échappées en JSON (`https:\/\/…`) sont matchées, `&amp;` est décodé,
les query strings survivent entières. Pour la plupart des sites voyage/e-commerce,
le mode `auto` (OpenGraph + schema.org JSON-LD/microdata) suffit sans aucune règle.

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
  (data seul), ou un sous-ensemble `["meta"|"jsonld"|"microdata"|"images"]`. Le HTML,
  lui, ne quitte **jamais** le service via /extract.
- **Défauts optionnels** : `profile: "lodging"` invoque un jeu de règles
  générique embarqué (`profiles/lodging.json` — name, description, city,
  country, latitude, longitude, rating, reviewCount, mainImage ; schema.org
  JSON-LD Hotel/VacationRental/Product, puis OpenGraph, puis microdata — un
  site JSON-LD et un site microdata passent par la même chaîne), pratique pour tester au curl
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

Attendu : `{"html":"<!doctype html>…`. Le premier appel peut être un peu
plus lent (cold start).

### CI (GitHub Actions — tout est en déclenchement manuel)

- **`smoke`** — le workflow de référence : exécute le code des moteurs sur
  le runner (sans clé), puis teste le service déployé (accueil, auth
  fail-closed, extraction Booking authentifiée, extraction Expedia via
  `cloak` pour vérifier que le binaire natif se charge en Lambda). Les tests
  authentifiés exigent le secret Actions `API_KEY`.
- Les autres workflows (`expedia-*`, `httpcloak`, `engine-bakeoff`,
  `richness`, `price-*`, `prices-photos`, `camoufox-test`, `scrapling`) sont des
  **sondes d'investigation** ponctuelles : ils documentent les mesures qui
  ont mené aux choix ci-dessus, ne testent pas le service en continu.

Le déploiement Netlify est sauté quand un push ne touche que `.github/` ou
le README ; pas de deploy previews ni de branch deploys.

## Limites connues

- **Moteur `browser` indisponible sur Netlify** (voir « Moteurs ») :
  Camoufox (663 Mo) ne tient pas dans le `/tmp` Lambda (512 Mo). Sur
  goupil-fetcher.netlify.app, `social`, `cloak`, `impit` et `plain`
  aboutissent (`managed` est inerte : `SCRAPERAPI_KEY` n'y est pas posée) ;
  `browser` échoue en
  `fetch_failed`. Si un jour il le faut : ce même repo en Docker
  (`server.mts`) avec Camoufox baké dans l'image.
- **Pas de prix** extrait pour l'instant (voir « Ce qui marche aujourd'hui »).
- **Pas d'exécution JavaScript** hors `browser` : une page dont la donnée
  n'arrive que par XHR reste vide pour les moteurs HTTP.
- **Timeout** : la fenêtre d'exécution dépend du plan Netlify (les functions
  synchrones ont un plafond bas). Les fetchs HTTP prennent quelques
  secondes ; une chaîne `auto` sur un domaine inconnu peut en cumuler
  plusieurs → l'appelant doit garder un fallback, ou nommer le moteur.
- **Pas de pool ni de file** : un appelant doit rate-limiter en amont.
- IP de sortie = celle de l'infra Netlify (US) — suffisant pour l'usage actuel.

## Consommateurs connus

- Hamak (`actions/fetch/browser.ts`, branche `SCRAPER_URL`) — parsing côté app.
