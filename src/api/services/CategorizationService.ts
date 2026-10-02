/**
 * Assigns a category to a deal from its title.
 *
 * None of the auto-discovery sources (Amazon/Cdiscount deal pages, Steam
 * specials) tells us which category an offer belongs to, so without this
 * every deal landed with `categoryId = null` and the category filter
 * matched nothing at all.
 *
 * Deliberately a keyword table rather than anything learned: at a few
 * deals a day it is accurate enough, it costs no network call, and a
 * mis-classification is fixed by editing one line here.
 */

/** Ordered: the first category with a matching keyword wins. */
const KEYWORDS: Array<{ categoryId: string; keywords: string[] }> = [
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
      "jardin",
      "barbecue",
      "piscine",
      "outil",
      "perceuse",
      "bricolage",
    ],
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
