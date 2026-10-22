/**
 * Computers: what PC buyers check before trusting a deal — the brand and
 * the spec sheet. Read from the title (and description) the merchants
 * write: "PC Portable Lenovo IdeaPad Slim 3 15" - Ryzen 5 7530U - 16 Go RAM
 * - 512 Go SSD".
 */

/** A computer, not an accessory for one (a laptop bag says "PC portable" too). */
const COMPUTER =
  /\b(pc portable|ordinateur portable|laptop|notebook|chromebook|ultrabook|macbook|mini[ -]?pc|pc gamer|pc fixe|ordinateur de bureau|unité centrale|tour gamer)\b/i;
const ACCESSORY =
  /\b(sacoche|sac à dos|sac pour|housse|support|refroidisseur|chargeur|adaptateur|câble|cable|station d'accueil|dock|clavier pour|batterie pour|coque|stand|tapis|écran pour|protection)\b/i;
/** Something only a computer's own spec sheet says. */
const HAS_SPECS =
  /\b(core\s?(i[3579]|ultra|[357])|ryzen|celeron|pentium|athlon|snapdragon|apple m[1-5]|\bm[1-5]\b|intel|amd|\d+\s?go\s?(de\s)?(ram|ddr)|ssd)\b/i;

/**
 * Makers PC buyers know and trust, plus the mini-PC brands the community
 * follows (Beelink, Minisforum, Geekom, GMKtec). Anything else — Bvate,
 * Ruzava, XWU… — went cold every time we posted one.
 */
const KNOWN_PC_BRANDS =
  /\b(lenovo|thinkpad|thinkbook|ideapad|legion|hp|omen|victus|elitebook|probook|dell|xps|inspiron|latitude|vostro|alienware|asus|rog|zenbook|vivobook|acer|msi|apple|macbook|mac mini|imac|microsoft|surface|samsung|galaxy book|huawei|matebook|honor|magicbook|gigabyte|aorus|razer|medion|dynabook|toshiba|lg gram|xiaomi|redmibook|framework|beelink|minisforum|geekom|gmktec)\b/i;

export function isComputer(title: string): boolean {
  return (
    COMPUTER.test(title) && !ACCESSORY.test(title) && HAS_SPECS.test(title)
  );
}

export function isKnownPcBrand(title: string): boolean {
  return KNOWN_PC_BRANDS.test(title);
}

export interface PcSpecs {
  ramGb?: number;
  storageGb?: number;
  cpu?: string;
}

export function parsePcSpecs(raw: string): PcSpecs {
  // "Intel® Core™ Ultra 5": the marks break the patterns below.
  const text = raw.replace(/[®™©]/g, "");
  const ram =
    text.match(/(\d{1,3})\s?go\s?(de\s)?(ram|ddr\d?|lpddr\d?x?|mémoire)/i) ??
    text.match(/ram\s?:?\s?(\d{1,3})\s?go/i);
  const tb = text.match(/(\d(?:[.,]\d)?)\s?to\s?(de\s)?(ssd|nvme)/i);
  const gb = text.match(/(\d{2,4})\s?go\s?(de\s)?(ssd|nvme|emmc)/i);
  const storage = tb
    ? Number(tb[1].replace(",", ".")) * 1000
    : gb
      ? Number(gb[1])
      : undefined;
  const cpu = text.match(
    // The model number is optional: "Core Ultra 7" alone is still worth
    // showing.
    /\b(core\s?ultra\s?\d(\s?\d{3}[a-z]*)?|core\s?i[3579]([\s-]?\d{4,5}[a-z]*)?|core\s?[357](\s?\d{3}[a-z]*)?|ryzen\s?(ai\s)?\d(\s?\d{3,4}[a-z]*)?|apple\s?m[1-5]( pro| max)?|snapdragon\s?x\s?(elite|plus)?|celeron\s?n?\d*|n\d{3,4})\b/i,
  )?.[0];
  return {
    ramGb: ram ? Number(ram[1]) : undefined,
    storageGb: storage,
    cpu: cpu?.replace(/\s+/g, " "),
  };
}

/**
 * What a PC buyer would object to at this price — said, not hidden. Only
 * for clear cases: 8 Go of RAM on a 600 €+ PC, 256 Go of storage above
 * 700 €, 4 Go of RAM at all.
 */
export function pcWarnings(specs: PcSpecs, price: number): string[] {
  const warnings: string[] = [];
  if (specs.ramGb !== undefined) {
    if (specs.ramGb <= 4) {
      warnings.push(
        `Seulement ${specs.ramGb} Go de RAM : insuffisant pour Windows aujourd'hui.`,
      );
    } else if (specs.ramGb <= 8 && price >= 600) {
      warnings.push(
        `8 Go de RAM à ce prix : 16 Go est le minimum attendu au-delà de 600 €.`,
      );
    } else if (specs.ramGb <= 16 && price >= 900) {
      // ThinkBook 14x at 1 003 €: « dommage pour les 16 Go, j'attends un
      // 32 Go en Ultra 7 dans les 1k ».
      warnings.push(
        `${specs.ramGb} Go de RAM à ce prix : la communauté attend 32 Go au-delà de ~900 €.`,
      );
    }
  }
  if (specs.storageGb !== undefined && specs.storageGb <= 256 && price >= 700) {
    warnings.push(
      `Stockage de ${specs.storageGb} Go seulement pour un PC à ce prix.`,
    );
  }
  return warnings;
}
