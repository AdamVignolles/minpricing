# DealRadar — Dossier d'architecture (v1)

> Périmètre confirmé : **outil privé** (pas de site public, pas de SEO) qui aide
> à repérer et **publier des deals sur Dealabs** : collecte de quelques
> produits/prix par jour sur **Amazon, Cdiscount et le jeu vidéo**, détection
> des vraies baisses de prix via historique, génération d'un **brouillon**,
> et publication automatique via un navigateur Playwright authentifié avec
> ta propre session Dealabs (login manuel une fois, `npm run dealabs:login`).
> Volume : quelques deals/jour, usage mono-utilisateur.

Ce dossier est volontairement recadré par rapport au brief initial
(agrégateur public multi-sources) : on garde la même colonne vertébrale
technique (collecte → normalisation → historique de prix → scoring →
dédup → API → dashboard), mais on enlève tout ce qui ne sert pas un outil
privé à faible volume (pas de SEO, pas de comptes utilisateurs publics, pas
de monétisation, pas de haute disponibilité).

---

## 1. Vision du projet

Un outil personnel qui :

1. surveille un petit catalogue de produits (Amazon, Cdiscount, jeux vidéo) ;
2. garde un historique de prix pour juger si une baisse est réelle ;
3. calcule un score de pertinence ;
4. te présente, dans une console privée, les produits dont la baisse est
   jugée intéressante, avec un **brouillon de post Dealabs pré-rempli**
   (titre, prix, lien, image, texte) ;
5. te laisse soit copier/ajuster ce brouillon et poster toi-même sur
   Dealabs, soit déclencher la **publication automatique** (bouton
   "Publication automatique") qui remplit et soumet le formulaire Dealabs
   pour toi via Playwright, en réutilisant une session que tu as toi-même
   ouverte (`npm run dealabs:login`).

Pas de site public, pas d'indexation, pas de compte utilisateur autre que
le tien (auth simple). La publication automatique utilise ta propre
session Dealabs (jamais ton mot de passe, jamais stocké par l'outil) ;
assume-la en connaissance de cause : elle peut enfreindre les CGU
anti-bot de Dealabs et risquer un bannissement de compte si Dealabs la
détecte — c'est un choix délibéré de l'utilisateur, documenté ici plutôt
que caché.

## 2. Fonctionnement global

```
Cron (Alepha $job cron)
   ↓
Collectors (Amazon / Cdiscount / jeux vidéo)
   ↓
Raw offers (payload brut par source)
   ↓
Normalisation (prix, devise, titre, URL canonique)
   ↓
Déduplication (par source+externalId, puis par URL canonique)
   ↓
Price history (insert seulement si le prix a changé)
   ↓
Scoring (vraie-baisse ?)
   ↓
D1 (Deal, PriceHistory, Source, Merchant, Category)
   ↓
API Alepha ($action)
   ↓
Console privée React (liste, détail, brouillon Dealabs)
```

Pas de Queue pour le MVP : à quelques deals/jour et 2-3 sources, un `$job`
cron qui appelle directement les collectors puis écrit en D1 tient largement
dans le temps CPU d'un Worker (voir §8). Une Queue sera ajoutée en V2 si le
nombre de produits suivis grossit significativement.

## 3. Architecture technique

- **Alepha** comme framework unique (API + jobs + ORM + React SSR), pas
  d'Express/Fastify parallèle.
- **Cloudflare Workers** comme runtime de prod, via `alepha/cli/platform`
  (adapter `cloudflare`).
- **D1** (SQLite) pour toutes les données relationnelles (Deal, PriceHistory,
  Source, Merchant, Category) — largement suffisant pour un catalogue de
  quelques centaines à quelques milliers de produits suivis.
- **R2** : optionnel, pour mettre en cache les images produit si on veut
  éviter de dépendre des CDN Amazon/Cdiscount dans le brouillon Dealabs.
  Non nécessaire au MVP (on peut lier l'image source directement).
- **Cloudflare Cron Triggers** via `$job({ cron: ... })` Alepha : un job par
  fréquence de collecte.
- **Pas de Queue au MVP** (voir §2) ; **KV non nécessaire** (D1 + cache Alepha
  suffisent).

## 4. Architecture Cloudflare

| Service        | Utilité ici                                       | À ne pas y mettre                                                  | Limites clés                                                                                                | Coût                                          |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Workers        | exécute l'API + les jobs cron                     | traitement > quelques dizaines de secondes en une seule invocation | CPU time par requête limité (plan gratuit ~10ms CPU / requête, payant ~50ms, jusqu'à 30s en config étendue) | Gratuit jusqu'à 100k req/jour, sinon ~5$/mois |
| D1             | Deal, PriceHistory, Source, Merchant, Category    | fichiers binaires/images                                           | taille DB et nombre de lignes généreux pour ce volume ; limites de lignes lues/écrites par requête          | Gratuit large tier, très faible ici           |
| R2 (optionnel) | cache d'images produit si besoin                  | données relationnelles                                             | —                                                                                                           | quasi nul au volume visé                      |
| Cron Triggers  | déclenche les jobs de collecte                    | logique métier elle-même                                           | jusqu'à plusieurs triggers, granularité minute                                                              | inclus                                        |
| Queues         | non utilisé au MVP, réservé V2 si volume augmente | —                                                                  | —                                                                                                           | —                                             |
| KV             | non utilisé au MVP                                | —                                                                  | —                                                                                                           | —                                             |

Le volume annoncé (quelques deals/jour, 2-3 sources) tient confortablement
dans le tier gratuit Cloudflare.

## 5. Architecture Alepha

Primitives vérifiées dans `node_modules/alepha/src` (version installée
0.30.x) :

- `$entity` (`alepha/orm`) : définit une table via un schéma Zod
  (`z.object({...})`), colonnes typées avec `db.primaryKey()`, etc.
- `$repository(entity)` (`alepha/orm`) : CRUD typé sur une entité ; variante
  avec `$relations` + clé pour les jointures (`include`).
- `$action` (`alepha/server` / racine `alepha`) : endpoint HTTP typé
  (méthode, schéma de requête/réponse, validation automatique).
- `$job` (`alepha/api/jobs` → exposé par `alepha`) : **soit** un job cron
  (`{ cron: "..." }`), **soit** un job de queue (`{ schema, ... }` +
  `push`), jamais les deux dans le même job. Pour un pipeline
  planifié-puis-traité, on compose : un job cron qui pousse des payloads +
  un job "queue" séparé qui les traite.
- `$topic` (`alepha/topic`) : pub/sub interne (utile plus tard pour
  découpler "nouveau deal détecté" de "générer le brouillon Dealabs"),
  pas indispensable au MVP.
- `$storage` (`alepha/api/files`) : uniquement si on cache des images (R2).
- `$cache` (`alepha/cache`) : cache des réponses API/pages produit
  (ex: éviter de re-scraper une fiche Cdiscount vue il y a 5 minutes).

Structure de projet (conforme au layout imposé par `AGENTS.md`, on ne
réinvente pas d'arborescence) :

```
src/
├── api/
│   ├── controllers/        # $action : deals, admin
│   ├── services/            # DealCollectionService, PricingService, ScoringService, DealabsDraftService
│   ├── entities/             # Deal, PriceHistory, Source, Merchant, Category
│   ├── schemas/               # DTOs Zod (requêtes/réponses)
│   ├── collectors/            # AmazonCollector, CdiscountCollector, VideoGameCollector
│   ├── jobs/                   # collectDeals (cron), par source ou groupé
│   └── index.ts                # ApiModule
├── web/
│   ├── components/           # DealList, DealDetail, DealabsDraftView, AdminPanel
│   ├── AppRouter.ts
│   └── index.ts               # WebModule
├── main.server.ts
├── main.browser.ts
└── main.css
```

## 6. Architecture des collectors

Interface commune, adaptée à Alepha (un collector est un service injectable,
pas juste une fonction) :

```ts
export interface RawDeal {
  externalId: string;
  title: string;
  url: string;
  imageUrl?: string;
  price: number;
  currency: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  merchantName: string;
  category?: string;
}

export interface DealSource {
  id: string; // ex: "amazon", "cdiscount", "videogames"
  name: string;
  collect(): Promise<RawDeal[]>;
}
```

Chaque collector (`AmazonCollector`, `CdiscountCollector`,
`VideoGameCollector`) implémente `DealSource` en tant que service Alepha
injectable, avec sa propre config (liste de produits/ASIN/URLs suivis,
rate limit, retry). Le job cron itère sur les collectors enregistrés et
appelle `collect()` pour chacun, avec un `try/catch` par source pour ne pas
qu'une source en échec bloque les autres.

### Analyse par méthode d'accès

| Méthode                     | Amazon                                                                                                                                                                                       | Cdiscount                                                                                                           | Jeux vidéo (ex: Instant Gaming, Steam, Eneba…)                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API officielle              | **PA-API** (Product Advertising API) — nécessite un compte Associates avec un historique de ventes qualifiantes ; sans ça, accès refusé. À vérifier au cas par cas selon ton statut affilié. | Pas d'API publique généraliste connue pour du grand public ; Cdiscount a une marketplace API vendeur, pas acheteur. | Steam a une **API officielle non-auth** pour les prix (`store.steampowered.com/api/...`) souvent utilisable. Les autres (Instant Gaming, Eneba) n'ont pas d'API publique documentée. |
| Flux RSS/Atom               | Non                                                                                                                                                                                          | Non                                                                                                                 | Non pour la plupart                                                                                                                                                                  |
| Scraping HTML               | Risqué : CGU Amazon interdisent le scraping, fort anti-bot, IP ban probable                                                                                                                  | Idem, CGU restrictives, anti-bot présent                                                                            | Variable selon le site, souvent plus permissif que Amazon/Cdiscount mais toujours à vérifier CGU/robots.txt au cas par cas                                                           |
| API non-officielles tierces | Il existe des services tiers payants qui exposent des données Amazon (ex: Keepa) — coût, dépendance externe                                                                                  | Peu d'équivalents fiables connus                                                                                    | Variable                                                                                                                                                                             |

**Recommandation MVP** : commencer par les produits où une donnée fiable
sans scraping agressif existe (API Steam pour jeux PC, PA-API si éligible
pour Amazon). Pour Cdiscount et les cas sans API, **saisie manuelle assistée**
au MVP : tu ajoutes toi-même une URL produit, l'outil va chercher le prix
affiché de façon ponctuelle et respectueuse (fréquence basse, un seul GET,
respect du `robots.txt`), sans contourner de protection anti-bot. On ne
scrape jamais de CAPTCHA/anti-bot — si un site bloque, la source est
marquée en erreur et il faut soit un accès API, soit une saisie manuelle.

### Élargir le volume de bons plans trouvés par `discover()`

`AmazonCollector`/`CdiscountCollector` fusionnent les cartes de **toutes**
les URLs de listing données (dédupliquées par ASIN/URL) avant d'appliquer
un plafond `limit` — donc les deux leviers pour en trouver plus :

1. **Ajouter des URLs de listing** via `AMAZON_DEALS_URL` /
   `CDISCOUNT_HOME_URL` (liste séparée par des virgules — chaque page
   supplémentaire (catégorie, promo dédiée…) contribue ses propres cartes
   gratuitement, avant même que `limit` s'applique).
2. **Relever `AMAZON_DEALS_LIMIT` / `CDISCOUNT_DEALS_LIMIT`** (défauts :
   40 / 60) — mais progressivement : pour Amazon, chaque candidat
   au-dessus de la limite précédente ouvre une page produit de plus, donc
   une requête de plus qui peut déclencher la protection anti-bot.

La grille de deals Amazon est **virtualisée** : le DOM ne contient jamais
que le lot de cartes proche de la position de scroll courante, les plus
anciennes étant démontées au fur et à mesure que de nouvelles apparaissent.
Deux conséquences vérifiées en direct sur `amazon.fr/deals` :

- Un grand saut `scrollTo(0, document.body.scrollHeight)` **vide** la
  grille (passée de 10 cartes à 0) car il saute par-dessus les zones de
  déclenchement des `IntersectionObserver` qui chargent le lot suivant.
- Même avec un scroll incrémental correct, ne lire le DOM qu'une seule
  fois à la fin ne capture que la dernière fenêtre de virtualisation
  (~5-10 cartes) — jamais l'ensemble réellement vu pendant le scroll.

`scrollAndCollect` (dans `browser.ts`) règle ça en scrollant un viewport à
la fois (`scrollBy`) et en **ré-extrayant et fusionnant les cartes
(dédupliquées par clé) après chaque étape**, pas seulement à la fin — vérifié
en conditions réelles : ~200 ASIN uniques récupérés sur une même page,
contre 5 à 10 avec une lecture unique. Il s'arrête après 3 étapes
consécutives sans progression du scroll (2 aurait coupé trop tôt : la
grille Amazon peut brièvement sembler ne plus avancer en pleine transition
entre deux fenêtres de virtualisation).

Cdiscount n'est pas concerné par ce problème : le carrousel "Bons plans"
de sa page d'accueil n'est pas virtualisé et ne contient qu'une poignée de
cartes statiques (~8) quel que soit le scroll — c'est une limite de
contenu, pas de technique de scraping. `CdiscountCollector` utilise quand
même `scrollAndCollect` par cohérence et au cas où une future page de
listing serait, elle, virtualisée.

## 7. Modèle de données

```ts
// entities/Deal.ts
const Deal = $entity({
  name: "deals",
  schema: z.object({
    id: db.primaryKey(),
    sourceId: z.text(), // FK logique -> sources.id
    externalId: z.text(),
    title: z.text(),
    url: z.text(),
    imageUrl: z.text().optional(),
    merchantId: z.text().optional(),
    categoryId: z.text().optional(),
    currentPrice: z.number(),
    oldPrice: z.number().optional(),
    currency: z.text().default("EUR"),
    discountPercentage: z.number().optional(),
    availability: z
      .enum(["in_stock", "out_of_stock", "unknown"])
      .default("unknown"),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    status: z.enum(["active", "expired", "archived"]).default("active"),
    score: z.number().default(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
  indexes: ["sourceId", "status", "score"],
});

// entities/PriceHistory.ts
const PriceHistory = $entity({
  name: "price_history",
  schema: z.object({
    id: db.primaryKey(),
    dealId: z.text(),
    price: z.number(),
    currency: z.text().default("EUR"),
    observedAt: z.iso.datetime(),
    source: z.text(),
  }),
  indexes: ["dealId", "observedAt"],
});

// entities/Source.ts
const Source = $entity({
  name: "sources",
  schema: z.object({
    id: db.primaryKey(),
    name: z.text(),
    type: z.enum(["api", "manual", "scrape"]),
    enabled: z.boolean().default(true),
    configuration: z.json().optional(),
    lastRunAt: z.iso.datetime().optional(),
    lastSuccessAt: z.iso.datetime().optional(),
    lastErrorAt: z.iso.datetime().optional(),
    lastError: z.text().optional(),
  }),
});

// entities/Merchant.ts, entities/Category.ts : id, name, (domain/logo | slug)

// Table additionnelle recommandée :
// dealabs_drafts : dealId, title, body, tags, generatedAt, status ("draft"|"posted"|"discarded")
```

`DealabsDraft` est la table clé propre à ce projet : elle stocke le
brouillon généré (titre formaté façon Dealabs, corps du message, lien
affilié le cas échéant) et son statut ("à relire" / "posté" / "ignoré").
Le passage à "posté" peut venir soit d'une vérification manuelle (lien
collé par l'utilisateur après un post manuel), soit de la publication
automatique elle-même une fois le formulaire Dealabs soumis avec succès.

## 8. Algorithme de détection des bons plans / historique de prix

- À chaque collecte, comparer `currentPrice` au dernier prix connu.
- **N'insérer une ligne `PriceHistory` que si le prix a changé** (ou toutes
  les 24h max en "heartbeat" pour garder une trace de fraîcheur) — évite les
  milliers de lignes inutiles à faible volume, et reste simple ici vu le
  peu de produits suivis.
- Métriques dérivées à la lecture (pas stockées, calculées depuis
  `PriceHistory`) : prix min/moyen/max historique, position du prix actuel
  par rapport à cet historique, réduction vs prix précédent / vs moyenne /
  vs max.

## 9. Algorithme de scoring (v1, simple)

Métriques retenues : réduction annoncée, écart au prix minimum historique,
écart au prix moyen historique, ancienneté de l'historique (plus il y a de
points, plus la confiance est haute), fiabilité de la source (API > saisie
manuelle > scrape), et — en bonus optionnel — écart à un prix de référence
marché externe (Idealo.fr, quand le produit suivi a une page Idealo
configurée).

```
score = clamp(0..100,
    40 * (discountVsAveragePrice)          // réduction par rapport au prix moyen, plus robuste que "prix barré"
  + 30 * (isNewHistoricalMin ? 1 : 0)      // vrai plus bas prix jamais vu = signal fort
  + 20 * sourceReliabilityWeight            // 1.0 API, 0.7 manuel, 0.4 scrape
  + 10 * min(historyPoints / 10, 1)        // confiance liée à la profondeur d'historique
  + 20 * (discountVsIdealoPrice)           // bonus : écart au prix de référence Idealo, 0 si absent
)
```

Le bonus Idealo (`IdealoReferenceService`) compare le prix actuel au prix
le plus bas listé sur Idealo.fr tous marchands confondus, ce qui permet de
distinguer un vrai bon plan (qui bat aussi le marché large) d'un produit
qui n'a simplement jamais baissé dans notre propre historique (souvent
mince, vu le peu de produits suivis). Scrapé via navigateur headless
(même mécanisme que Amazon/Cdiscount, voir `browser.ts`), avec un cache de
24h sur `TrackedProduct.idealoReferencePrice` : Idealo a une protection
anti-bot agressive, donc un échec de scrape ne bloque jamais la collecte —
le dernier prix en cache est réutilisé, ou le bonus vaut simplement 0.

Volontairement simple et explicable ligne par ligne (pas de boîte noire) ;
évolutif plus tard (pondérations ajustables en config, puis modèle appris
si le volume de données le justifie un jour — pas au MVP).

### Classification du bon plan

En plus du score numérique, `ScoringService.classifyDeal` range chaque
offre dans une étiquette lisible : `excellent` / `good` / `average` /
`overpriced` / `unknown`. Mêmes comparaisons que le score (prix de
référence Idealo si disponible, sinon écart à la moyenne historique), donc
l'étiquette ne peut jamais contredire le score affiché à côté. Exposée par
`GET /deals/:id/price-stats` (`classification`) et affichée sur la fiche
détail comme badge ("Excellente affaire", "Prix normal", "Au-dessus du
marché"…), à côté du graphique d'historique qui trace aussi le prix de
référence Idealo en ligne horizontale quand il est connu.

### Historique de prix Idealo (best-effort)

À l'ouverture d'une fiche de bon plan, si le produit suivi a un `idealoUrl`
configuré, le front appelle `GET /deals/:id/idealo-history`, qui déclenche
un scrape **en direct** (pas de cache, pas de pré-collecte : une seule
visite, pas un run de collecte à protéger) du graphique "évolution du
prix" d'Idealo via `IdealoReferenceService.getPriceHistory`, affiché dans
un second graphique sous l'historique de nos propres relevés.

Important : Idealo a renvoyé un 403 brut (aucun HTML, aucune donnée JS) à
chaque tentative de scrape faite depuis cet environnement de
développement — la vraie structure du graphique n'a donc jamais pu être
inspectée. `scrapeIdealoHistory` essaie plusieurs stratégies génériques
(globals SSR usuels `__NEXT_DATA__`/`__NUXT__`/..., scan structurel de tout
JSON inline ressemblant à une série date/prix, attribut `data-*` d'un
conteneur de graphique) plutôt qu'un sélecteur unique conçu sur la vraie
page — sans garantie que l'une d'elles corresponde au marquage réel
d'Idealo. Dégrade toujours proprement (`available: false`, jamais
d'erreur, jamais de donnée inventée) si rien ne correspond ou si Idealo
bloque la requête. À réévaluer/ajuster une fois testé depuis un
environnement qui n'est pas bloqué par Idealo.

## 10. Déduplication

1. Clé primaire de dédup : `(sourceId, externalId)`.
2. Fallback : URL canonique normalisée (sans paramètres de tracking).
3. Pas de fuzzy matching / IA au MVP — au volume visé (quelques produits
   suivis manuellement), la dédup manuelle par toi à l'ajout d'un produit
   est suffisante. Prévu comme amélioration V2 si le nombre de sources
   grossit (normalisation de titre + comparaison marchand).

## 11. Architecture des jobs

- `collectDealsJob` : `$job({ cron: "*/30 * * * *" })` (ou fréquence choisie
  par toi) qui itère sur les `Source` actives et appelle chaque collector.
- Pas de Queue au MVP (volume trop faible pour le justifier) ; si un futur
  collector devient lourd (beaucoup de produits, retries longs), on migre
  ce collector spécifique vers un job "queue" poussé par le cron, sans
  changer les autres.
- Génération de brouillon Dealabs : synchrone, déclenchée juste après
  qu'un deal dépasse le seuil de score, dans la même exécution de job
  (pas besoin de découpler via `$topic` au MVP vu le volume ; à activer en
  V2 si on ajoute par ex. des notifications).

## 12. API

```
GET  /api/deals                 ?status=active&minScore=&sort=score|-createdAt
GET  /api/deals/:id
GET  /api/deals/:id/history      # points de PriceHistory pour le graphique
GET  /api/categories
GET  /api/merchants
GET  /api/sources
GET  /api/admin/stats            # compteurs globaux
GET  /api/admin/sources          # état par source (lastRunAt, lastError...)
POST /api/deals/:id/draft/regenerate
PATCH /api/deals/:id/draft        # éditer le brouillon avant de le poster toi-même
```

Toutes en `$action` Alepha, avec schémas Zod de requête/réponse. Routes
`/api/admin/*` protégées (auth simple, un seul utilisateur — voir §14).

## 13. Architecture frontend / Console privée

- Pas de SSR public à indexer : simple app React (via Alepha) servie
  derrière l'auth.
- Écrans : liste des deals (filtre statut/score/catégorie/source), détail
  d'un deal avec graphique d'historique de prix (lib légère, ex: recharts),
  vue "brouillon Dealabs" éditable + bouton copier, panneau admin (état des
  sources, dernières erreurs).
- Mantine pour le style et les composants (`@mantine/core`, `charts`,
  `notifications`), pas de nouvelle lib CSS.

## 14. Sécurité

- Auth minimale (un seul utilisateur : toi) — session/cookie signé via
  `APP_SECRET` (déjà géré par Alepha, cf. `AGENTS.md`).
- Aucune clé API (PA-API, etc.) côté frontend : uniquement en variables
  d'env serveur.
- Validation Zod systématique des entrées (URLs ajoutées, config source).
- Pas de scraping contournant anti-bot/CAPTCHA — une source qui en a besoin
  reste "manuelle".
- Logs sans secrets.

## 15. Performance

Au volume annoncé (quelques deals/jour, catalogue de quelques centaines de
produits max), aucune optimisation particulière n'est nécessaire au-delà de :
index sur `(sourceId, status)` et `(dealId, observedAt)`, pagination simple
(offset suffit à ce volume, pas besoin de cursor-based tout de suite),
`SELECT` restreint aux colonnes utilisées par chaque vue.

## 16. Observabilité

- Champs `lastRunAt/lastSuccessAt/lastErrorAt/lastError` sur `Source`,
  affichés dans le panneau admin — suffisant à ce volume, pas besoin d'un
  outil externe de métriques au MVP.
- Logs structurés Alepha (`$logger`) autour de chaque collector : nombre
  d'offres récupérées, nouvelles, doublons, erreurs, durée.

## 17. Tests

- Collectors testés avec des fixtures HTTP/JSON figées (pas d'appel réseau
  réel dans les tests).
- Tests unitaires : normalisation de prix, calcul de scoring, dédup,
  génération du brouillon Dealabs.
- Tests des repositories (D1 en mémoire / sqlite de test) et des `$action`
  (requête/réponse).

## 18. Déploiement

Local (`alepha dev`, sqlite locale) → `alepha platform up --env production`
(Cloudflare : D1 + Workers + Cron), secrets poussés via le plugin
`platform` (voir `AGENTS.md`). Pas d'environnement de staging séparé
nécessaire vu l'usage personnel — un simple `--dry-run`/`platform plan`
avant `up` suffit à vérifier les changements.

## 19. Coût estimatif

Quasiment nul : Workers/D1/Cron restent dans les tiers gratuits Cloudflare
au volume annoncé (quelques exécutions cron/jour, quelques centaines de
lignes). Coût principal potentiel : un abonnement Keepa ou équivalent
_seulement si_ tu veux des données de prix Amazon plus riches que PA-API —
non nécessaire au MVP.

## 20. Limites et risques

- Amazon PA-API : accès conditionné à un statut Associates actif — à
  vérifier ; sinon, saisie manuelle pour Amazon au MVP.
- Cdiscount : pas d'API publique fiable connue — saisie manuelle assistée.
- Scraping : jamais en contournement d'anti-bot/CAPTCHA ; toute source qui
  l'exige reste "manuelle" plutôt que "scrape".
- Publication Dealabs : automatisée via Playwright + une session que tu
  ouvres toi-même (`npm run dealabs:login`). Risque assumé : CGU de la
  plateforme, risque de ban de compte si l'automatisation est détectée.
  L'outil ne stocke jamais ton mot de passe Dealabs, seulement un fichier
  de session local (cookies/local storage), et refuse de tourner sur le
  déploiement serverless (pas de navigateur persistant possible sur
  Workers). En cas d'échec du formulaire auto (sélecteurs Dealabs qui
  changent), le flux copier/coller manuel reste disponible en secours.

## 21. MVP

1. Scaffold Alepha (déjà fait).
2. Entités `Deal`, `PriceHistory`, `Source`, `Merchant`, `Category`,
   `DealabsDraft`.
3. Un collector "manuel" générique (tu fournis une URL + prix relevé,
   ou un GET ponctuel respectueux du robots.txt) pour Amazon/Cdiscount.
4. Collector Steam (API officielle) pour les jeux vidéo.
5. Job cron de collecte + mise à jour `PriceHistory` (insert si prix
   changé) + calcul du score.
6. Génération automatique du `DealabsDraft` quand le score dépasse un seuil.
7. API `$action` (deals, sources, admin/stats).
8. Console React : liste, détail + graphique, vue brouillon éditable,
   panneau admin.
9. Déploiement Cloudflare (D1 + Cron).

## 22. V2 / V3 (idées, non implémentées)

- V2 : dédup fuzzy (titre normalisé + marchand), Queue si le nombre de
  produits suivis grossit fortement, notifications (email/push) sur
  nouveau bon plan détecté, scraping additionnel de sources jeux vidéo
  vérifiées légalement accessibles.
- V3 : scoring pondérable en config, ajout d'autres marchands, historique
  de tes posts Dealabs réellement publiés (taux d'acceptation, clics si
  lien affilié).

## 23. Roadmap de développement (étapes testables indépendamment)

1. **Entités + repositories** — créer `Deal`, `PriceHistory`, `Source`,
   `Merchant`, `Category`, `DealabsDraft` dans `src/api/entities/`.
   Test : `alepha test` sur un repository CRUD basique.
2. **API deals en lecture seule** — `$action` `GET /api/deals`,
   `GET /api/deals/:id` avec données de seed.
   Test : requête HTTP retourne le seed attendu.
3. **Collector manuel** — service qui prend une URL + prix, écrit dans
   `Deal`/`PriceHistory` avec dédup par URL canonique.
   Test unitaire avec fixture, sans réseau.
4. **Collector Steam** — appel API officielle, fixture JSON en test.
5. **Job cron** — `$job({ cron })` qui appelle les collectors actifs,
   logs `Source.lastRunAt/lastError`.
   Test : exécution manuelle du handler avec collectors mockés.
6. **Scoring + seuil** — fonction pure testée unitairement sur des cas
   (vraie baisse / fausse baisse / historique insuffisant).
7. **Génération de brouillon Dealabs** — template texte à partir d'un
   `Deal` + `PriceHistory`, testé sur des cas fixtures.
8. **Console React** — liste + détail + graphique + vue brouillon.
9. **Panneau admin** — état des sources, erreurs.
10. **Déploiement Cloudflare** — `alepha platform plan` puis `up`,
    vérification via `alepha platform status`.

Chaque étape se valide avec `alepha test` (unités concernées) et, pour les
étapes API/cron, un test manuel via `alepha dev`.
