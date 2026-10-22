/**
 * Price histories from outside our own collection, for deals Keepa can't
 * chart (Keepa is Amazon only). Pure parsing here; fetching, pacing and
 * caching in `PriceSeriesService`.
 */

export interface PriceSeries {
  /** Where the history comes from, as shown to people ("Nintendo eShop, via DekuDeals"). */
  source: string;
  /** Page with the full history, to link to. */
  url: string;
  /** One point per price change, oldest first: [ISO date, price]. */
  points: Array<[string, number]>;
}

/** "Hogwarts Legacy : L'Héritage… (Nintendo Switch, eShop)" → comparable words. */
function words(title: string): string {
  return title
    .replace(/\((nintendo switch[^)]*|eshop)[^)]*\)/gi, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Our Nintendo deal title without the platform suffix we add. */
export function nintendoGameName(title: string): string {
  return title.replace(/\s*\((?:Nintendo Switch[^)]*|eShop)\)\s*$/i, "").trim();
}

/**
 * DekuDeals search results → the item whose name is our game's (exact
 * words), never a DLC or a bundle that merely starts the same way.
 */
export function pickDekuItem(html: string, title: string): string | undefined {
  const target = words(nintendoGameName(title));
  // "Hogwarts Legacy : L'Héritage de Poudlard" is "Hogwarts Legacy" there.
  const short = target.split(" l heritage")[0];
  for (const match of html.matchAll(
    /href=['"]\/items\/([a-z0-9-]+)['"][^>]*>([\s\S]{0,400}?)<\/a>/g,
  )) {
    const name = words(match[2].replace(/<[^>]+>/g, " "));
    if (name && (name === target || name === short)) return match[1];
  }
  return undefined;
}

/**
 * The page's `price_history_data` JSON: daily rows of
 * [date, sale?, price per store column…]. Keeps the eShop column for the
 * console the deal is for (Switch 2 when the title says so), and only the
 * days the price changed.
 */
export function parseDekuHistory(
  html: string,
  switch2: boolean,
): Array<[string, number]> {
  const raw = html.match(
    /<script id=['"]price_history_data['"][^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  if (!raw) return [];
  let data: { headers?: string[]; data?: Array<Array<string | number | null>> };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const headers = data.headers ?? [];
  const wanted = headers.findIndex((h) =>
    switch2 ? /switch 2/i.test(h) : /eshop \(switch\)/i.test(h),
  );
  const column = wanted >= 0 ? wanted : 0;
  const points: Array<[string, number]> = [];
  for (const row of data.data ?? []) {
    // Row: [date, <unused>, column 0, column 1, …]
    const price = row[2 + column];
    if (typeof row[0] !== "string" || typeof price !== "number") continue;
    if (points.length === 0 || points[points.length - 1][1] !== price) {
      points.push([row[0], price]);
    }
  }
  return points;
}

/** Lowest price of a series since `since` (ISO date), with its date. */
export function seriesLow(
  points: Array<[string, number]>,
  since?: string,
): { price: number; at: string } | undefined {
  let low: { price: number; at: string } | undefined;
  for (const [at, price] of points) {
    if (since && at < since) continue;
    if (!low || price < low.price) low = { price, at };
  }
  return low;
}

/**
 * A stepped line chart of the last `days` (QuickChart / Chart.js config),
 * for an image in the Dealabs description.
 */
export function seriesChartConfig(
  series: PriceSeries,
  title: string,
  today: string,
  days = 365,
): unknown {
  const since = new Date(new Date(today).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  // One point a week, the price in force that day: the x axis is plain
  // labels, so evenly spaced samples keep it proportional to time.
  const priceOn = (day: string) =>
    series.points.filter(([at]) => at <= day).pop()?.[1];
  const points: Array<[string, number]> = [];
  for (
    let t = new Date(since).getTime();
    t <= new Date(today).getTime();
    t += 7 * 86_400_000
  ) {
    const day = new Date(t).toISOString().slice(0, 10);
    const price = priceOn(day);
    if (price !== undefined) points.push([day, price]);
  }
  const last = priceOn(today);
  if (last !== undefined && points.at(-1)?.[0] !== today) {
    points.push([today, last]);
  }
  return {
    type: "line",
    data: {
      labels: points.map(([at]) => at),
      datasets: [
        {
          label: series.source,
          data: points.map(([, price]) => price),
          stepped: true,
          fill: true,
          borderColor: "#1c7ed6",
          backgroundColor: "rgba(28,126,214,0.12)",
          pointRadius: 0,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title.slice(0, 90) },
        legend: { display: true, position: "bottom" },
      },
      scales: {
        // Dates as plain labels (a time axis needs an adapter QuickChart
        // doesn't load); Chart.js skips the ones that don't fit.
        x: { ticks: { maxTicksLimit: 8 } },
        y: { title: { display: true, text: "€" } },
      },
    },
  };
}
