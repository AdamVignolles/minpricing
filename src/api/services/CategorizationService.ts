/**
 * Assigns a category to a deal.
 *
 * First from the merchant's own classification when the collector saw one
 * (see {@link CategorizationService.fromHint}): the Amazon deals collection
 * it was listed in, the Cdiscount URL path, the Amazon breadcrumb. Then,
 * as a fallback, from keywords in the title.
 *
 * Deliberately tables rather than anything learned: accurate enough at
 * this volume, no network call, and a mis-classification is fixed by
 * editing one line here.
 */

/**
 * Merchant classification → category. Ordered: the first matching pattern
 * wins, so more specific paths (e.g. Cdiscount's baby section, which lives
 * under `pret-a-porter/`) come before broader ones.
 */
const HINTS: Array<{ pattern: RegExp; categoryId: string }> = [
  // Amazon deals collections (`/deals?bubble-id=deals-collection-…`)
  { pattern: /^amazon:(toys|baby)$/, categoryId: "kids" },
  { pattern: /^amazon:(home-and-kitchen|furniture)$/, categoryId: "home" },
  { pattern: /^amazon:lawn-and-garden$/, categoryId: "diy" },
  {
    pattern: /^amazon:(beauty|health-and-personal-care)$/,
    categoryId: "beauty-health",
  },
  {
    pattern: /^amazon:(fashion|bags-and-luggage|jewelry-and-watches)$/,
    categoryId: "fashion",
  },
  { pattern: /^amazon:sports-and-outdoors$/, categoryId: "sport" },
  { pattern: /^amazon:automotive$/, categoryId: "auto" },
  { pattern: /^amazon:animalerie$/, categoryId: "pets" },
  { pattern: /^amazon:(grocery|beer-wine-and-spirits)$/, categoryId: "food" },
  { pattern: /^amazon:computing-and-software$/, categoryId: "computing" },
  { pattern: /^amazon:mobile-phones-and-accessories$/, categoryId: "phones" },
  { pattern: /^amazon:headphones-and-speakers$/, categoryId: "audio" },
  {
    pattern: /^amazon:(tv-and-home-cinema|cameras-and-accessories)$/,
    categoryId: "tv-photo",
  },
  {
    pattern: /^amazon:video-games-and-accessories$/,
    categoryId: "video-games",
  },
  // Amazon product-page breadcrumb root ("Cuisine et Maison › …")
  { pattern: /^amazon-crumb:(Jeux et Jouets|Bébé)/i, categoryId: "kids" },
  { pattern: /^amazon-crumb:(Bricolage|Jardin)/i, categoryId: "diy" },
  { pattern: /^amazon-crumb:Gros électroménager/i, categoryId: "appliances" },
  {
    pattern: /^amazon-crumb:(Cuisine|Maison|Fournitures de bureau)/i,
    categoryId: "home",
  },
  {
    pattern: /^amazon-crumb:(Beauté|Hygiène|Santé)/i,
    categoryId: "beauty-health",
  },
  {
    pattern:
      /^amazon-crumb:(Mode|Vêtements|Chaussures|Bagages|Bijoux|Montres)/i,
    categoryId: "fashion",
  },
  { pattern: /^amazon-crumb:Sports/i, categoryId: "sport" },
  { pattern: /^amazon-crumb:Auto/i, categoryId: "auto" },
  { pattern: /^amazon-crumb:Animalerie/i, categoryId: "pets" },
  {
    pattern: /^amazon-crumb:(Epicerie|Épicerie|Boissons)/i,
    categoryId: "food",
  },
  { pattern: /^amazon-crumb:Informatique/i, categoryId: "computing" },
  { pattern: /^amazon-crumb:Jeux vidéo/i, categoryId: "video-games" },
  // Cdiscount URL path (`cdiscount.com/<section>/<sub>/…`)
  {
    pattern: /^cdiscount:pret-a-porter\/bebe-puericulture/,
    categoryId: "kids",
  },
  { pattern: /^cdiscount:(juniors|puericulture)/, categoryId: "kids" },
  {
    pattern: /^cdiscount:(maison|literie-linge-de-maison)/,
    categoryId: "home",
  },
  { pattern: /^cdiscount:(jardin|bricolage)/, categoryId: "diy" },
  { pattern: /^cdiscount:electromenager/, categoryId: "appliances" },
  { pattern: /^cdiscount:le-sport/, categoryId: "sport" },
  {
    pattern: /^cdiscount:(pret-a-porter|mode|chaussures|bijouterie|bagages)/,
    categoryId: "fashion",
  },
  {
    pattern: /^cdiscount:au-quotidien\/hygiene-soin-beaute/,
    categoryId: "beauty-health",
  },
  { pattern: /^cdiscount:vin-alimentaire/, categoryId: "food" },
  { pattern: /^cdiscount:animalerie/, categoryId: "pets" },
  { pattern: /^cdiscount:auto/, categoryId: "auto" },
  { pattern: /^cdiscount:informatique/, categoryId: "computing" },
  { pattern: /^cdiscount:telephonie/, categoryId: "phones" },
  { pattern: /^cdiscount:jeux-pc-video-console/, categoryId: "video-games" },
  {
    pattern: /^cdiscount:(high-tech|photo-numerique|tv-video)/,
    categoryId: "tv-photo",
  },
];

/** Ordered: the first category with a matching keyword wins. */
const KEYWORDS: Array<{ categoryId: string; keywords: string[] }> = [
  {
    // Before video games: "LEGO … Jeu Interactif" is a toy.
    categoryId: "kids",
    keywords: [
      "lego",
      "playmobil",
      "jouet",
      "peluche",
      "poupée",
      "puzzle",
      "poussette",
      "siège auto",
      "bébé",
      "bebe",
      "enfant",
      "pat patrouille",
    ],
  },
  {
    categoryId: "video-games",
    keywords: [
      "jeu",
      "jeux",
      "playstation",
      "ps5",
      "ps4",
      "xbox",
      "nintendo",
      "switch",
      "steam",
      "manette",
      "console",
      "gaming",
    ],
  },
  {
    categoryId: "computing",
    keywords: [
      "pc ",
      "ordinateur",
      "portable",
      "laptop",
      "macbook",
      "ssd",
      "disque dur",
      "nvme",
      "ram ",
      "processeur",
      "carte graphique",
      "rtx",
      "ryzen",
      "intel",
      "clavier",
      "souris",
      "écran",
      "ecran",
      "moniteur",
      "imprimante",
      "routeur",
      "wifi",
      "clé usb",
      "webcam",
    ],
  },
  {
    categoryId: "phones",
    keywords: [
      "smartphone",
      "iphone",
      "samsung galaxy",
      "xiaomi",
      "redmi",
      "pixel",
      "téléphone",
      "telephone",
      "tablette",
      "ipad",
      "coque",
      "chargeur",
      "powerbank",
      "batterie externe",
    ],
  },
  {
    categoryId: "audio",
    keywords: [
      "casque",
      "écouteur",
      "ecouteur",
      "airpods",
      "enceinte",
      "barre de son",
      "bluetooth speaker",
      "hifi",
      "home cinéma",
      "home cinema",
      "echo dot",
      "soundbar",
    ],
  },
  {
    categoryId: "tv-photo",
    keywords: [
      "tv ",
      "télévision",
      "television",
      "oled",
      "qled",
      "vidéoprojecteur",
      "videoprojecteur",
      "appareil photo",
      "objectif",
      "gopro",
      "caméra",
      "camera",
      "drone",
      "liseuse",
      "kindle",
    ],
  },
  {
    categoryId: "appliances",
    keywords: [
      "aspirateur",
      "lave-linge",
      "lave-vaisselle",
      "réfrigérateur",
      "refrigerateur",
      "congélateur",
      "micro-ondes",
      "four ",
      "cafetière",
      "cafetiere",
      "friteuse",
      "airfryer",
      "robot cuisine",
      "blender",
      "bouilloire",
      "climatiseur",
      "ventilateur",
      "chauffage",
    ],
  },
  {
    categoryId: "home",
    keywords: [
      "canapé",
      "canape",
      "matelas",
      "lit ",
      "table",
      "chaise",
      "meuble",
      "bureau",
      "étagère",
      "etagere",
      "luminaire",
      "lampe",
      "décoration",
      "decoration",
      // Not plain "tapis": "tapis de course" is sport.
      "tapis extérieur",
      "tapis de salon",
      "coiffeuse",
      "armoire",
      "batterie de cuisine",
      "poêle",
      "serpillière",
      "balai",
    ],
  },
  {
    categoryId: "diy",
    keywords: [
      "jardin",
      "barbecue",
      "piscine",
      "outil",
      "perceuse",
      "visseuse",
      "tronçonneuse",
      "nettoyeur haute pression",
      "tondeuse à gazon",
      "bricolage",
      "piles",
    ],
  },
  {
    categoryId: "sport",
    keywords: [
      "tapis de course",
      "tapis de marche",
      "vélo d'appartement",
      "haltère",
      "fitness",
      "musculation",
      "yoga",
      "survêtement",
      "running",
      "randonnée",
      "camping",
    ],
  },
  {
    categoryId: "food",
    keywords: [
      "café en grains",
      "capsules",
      "chocolat",
      "bonbons",
      "vin ",
      "bière",
      "gin ",
    ],
  },
  {
    categoryId: "pets",
    keywords: ["chien", "chat ", "croquettes", "litière", "aquarium"],
  },
  {
    categoryId: "fashion",
    keywords: [
      "chaussure",
      "basket",
      "sneaker",
      "veste",
      "manteau",
      "pantalon",
      "jean",
      "robe",
      "t-shirt",
      "pull",
      "sac à main",
      "montre",
      "lunettes",
      "bijou",
      "doudoune",
      "parka",
      "boxer",
      "culotte",
      "chaussettes",
      "valise",
    ],
  },
  {
    categoryId: "beauty-health",
    keywords: [
      "parfum",
      "crème",
      "creme",
      "soin",
      "shampoing",
      "rasoir",
      "brosse à dents",
      "épilateur",
      "epilateur",
      "maquillage",
      "sèche-cheveux",
      "seche-cheveux",
      "complément alimentaire",
    ],
  },
  {
    categoryId: "auto",
    keywords: [
      "pneu",
      "voiture",
      "auto ",
      "moto",
      "gps",
      "dashcam",
      "autoradio",
      "vélo",
      "velo",
      "trottinette",
      "casque moto",
    ],
  },
];

export class CategorizationService {
  /**
   * Category from the merchant's own classification (see
   * `RawDeal.categoryHint`), or `undefined` when the hint is missing or
   * too generic (e.g. Amazon's "all deals" collection).
   */
  fromHint(hint: string | undefined): string | undefined {
    if (!hint) {
      return undefined;
    }
    return HINTS.find(({ pattern }) => pattern.test(hint))?.categoryId;
  }

  /** Merchant hint first, title keywords as the fallback. */
  categorize(title: string, ...hints: Array<string | undefined>): string {
    for (const hint of hints) {
      const fromHint = this.fromHint(hint);
      if (fromHint) {
        return fromHint;
      }
    }
    return this.classify(title);
  }

  /**
   * @returns the best matching category id, or "other" when nothing
   * matches — never `undefined`, so the category filter always has
   * something to group by.
   */
  classify(title: string): string {
    const haystack = ` ${title.toLowerCase()} `;

    for (const { categoryId, keywords } of KEYWORDS) {
      if (keywords.some((keyword) => haystack.includes(keyword))) {
        return categoryId;
      }
    }

    return "other";
  }
}
