/**
 * The French phrase bank of the Dealabs descriptions (epic 27). Only
 * wording lives here: every `{…}` is filled from a fact, and a phrase
 * whose fact is missing is not used. No superlative, no opinion, no
 * mention of DealRadar, of a score or of a chance to heat.
 *
 * Several variants per phrase so posts don't all read the same; the
 * renderer picks one deterministically per deal (same deal, same text).
 */
export const PHRASES = {
  intro: {
    game: ["Jeu {platforms} sur {store}.", "Version {platforms}, sur {store}."],
    freeGame: [
      "Jeu offert sur {store}.",
      "À récupérer gratuitement sur {store}.",
    ],
    plan: ["Forfait proposé par {merchant}.", "Offre {merchant}."],
  },
  sections: {
    howTo: "Pour obtenir le prix :",
    highlights: ["Points forts :", "En bref :"],
    specs: "Caractéristiques :",
    game: "Le jeu :",
    plan: "L'offre :",
    seller: "Vendeur et livraison :",
    notes: "À savoir :",
  },
  howTo: {
    coupon: "Activer le coupon de {coupon} sur la page du produit",
    code: "Code promo à saisir : {code}",
  },
  seller: {
    self: "Vendu et expédié par {seller}",
    soldShippedBy: "Vendu par {seller}, expédié par {shipper}",
    thirdParty: "Vendu par {seller} (vendeur tiers{sellerStats})",
    thirdPartyShippedBy:
      "Vendu par {seller} (vendeur tiers{sellerStats}), expédié par {shipper}",
    sellerStats: ", {rating}/5 sur {sales} ventes",
    reviews: "Note des acheteurs : {rating}/5 sur {count} avis",
    freeDelivery: "Livraison gratuite",
    returns: "{returns}",
    warranty: "{warranty}",
    stock: "{stock}",
    shipsFrom: "Expédié depuis : {country}",
  },
  game: {
    platforms: "Plateformes : {platforms}",
    languages: "Langue : {languages}",
    features: "Fonctions : {features}",
    freeUntil:
      "Gratuit jusqu'au {date}, le jeu reste ensuite dans la bibliothèque",
  },
  notes: {
    "marketplace-seller": "Vendu par un vendeur tiers, pas par {merchant}",
    "ships-from-abroad": "Expédié depuis l'étranger ({country})",
    "battery-not-included": "Batterie et chargeur non inclus",
    "keyboard-layout": "Clavier {layout}, pas AZERTY",
    refurbished: "Produit reconditionné",
    used: "Produit d'occasion",
    "compatible-part": "Pièce compatible, pas d'origine",
    "out-of-stock": "Indiqué en rupture de stock sur la page",
    "store-pickup-only": "Retrait en magasin uniquement (Click & Collect)",
  },
} as const;

/** Country codes we may print, in French. Anything else is printed as is. */
export const COUNTRIES: Record<string, string> = {
  CN: "Chine",
  HK: "Hong Kong",
  DE: "Allemagne",
  ES: "Espagne",
  IT: "Italie",
  GB: "Royaume-Uni",
  UK: "Royaume-Uni",
  US: "États-Unis",
  PL: "Pologne",
  NL: "Pays-Bas",
  BE: "Belgique",
};
