/**
 * Live meta data source (Architecture.md section 2.1).
 *
 * Provider: Pikalytics JSON endpoints for Pokémon Champions Regulation M-C data.
 * Pikalytics exposes English-ready data at:
 *
 *   https://www.pikalytics.com/api/p/{YYYY-MM}/{format-rating}
 *   https://www.pikalytics.com/api/p/{YYYY-MM}/{format-rating}/{pokemon-slug}
 *
 * The current Champions M-C Showdown doubles key is `gen9championsvgc2026regmc-1760`.
 * Pikalytics returns the
 * literal JSON value `false` for unavailable months, so this module discovers the latest available
 * month by probing a preferred month and then recent months newest-first. A bundled seed remains
 * only as an outage fallback.
 */

import axios from 'axios';
import type {
  GetMetaSnapshotRequest,
  GetMetaSnapshotResponse,
  GetPokemonOptionsRequest,
  GetPokemonOptionsResponse,
  InputCorrection,
  MetaPokemonSummary,
  MetaSpread,
  PokemonOptionUsage,
  StatTable,
} from '../types';
import { getCanonicalMegaAbility } from '../utils/calc';
import {
  candidateSlugsForPokemon,
  nameKey,
  resolveShowdownSpecies,
  squashedKey,
  suggestPokemonNames,
  toPokeChamDbSlug,
  UserInputError,
} from '../utils/pokemon-name';

type MetaCache = {
  generatedAt: number;
  data: MetaPokemonSummary[];
  source: string;
  provider: 'pikalytics' | 'fallback';
  slugByPokemon: Map<string, string>;
  displayByPokemon: Map<string, string>;
  detailByPokemon: Map<string, PikalyticsPokemonEntry>;
  period?: PikalyticsPeriod;
};

type PikalyticsPeriod = {
  date: string;
  key: string;
  format: string;
  rating: string;
};

type PikalyticsUsageEntry = {
  percent?: string | number;
};

type PikalyticsMoveEntry = PikalyticsUsageEntry & {
  move?: string;
  type?: string;
};

type PikalyticsItemEntry = PikalyticsUsageEntry & {
  item?: string;
  item_us?: string;
};

type PikalyticsAbilityEntry = PikalyticsUsageEntry & {
  ability?: string;
};

type PikalyticsNatureEntry = PikalyticsUsageEntry & {
  nature?: string;
};

type PikalyticsSpreadEntry = PikalyticsUsageEntry & {
  nature?: string;
  ev?: string;
};

type PikalyticsRelatedPokemonEntry = PikalyticsUsageEntry & {
  pokemon?: string;
  pokemon_trans?: string;
  name?: string;
  rank?: number | string;
};

type PikalyticsPokemonEntry = {
  name?: string;
  name_trans?: string | null;
  display_name?: string | null;
  ranking?: string | number;
  rank?: string | number;
  winPercent?: string | number;
  moves?: PikalyticsMoveEntry[];
  items?: PikalyticsItemEntry[];
  abilities?: PikalyticsAbilityEntry[];
  natures?: PikalyticsNatureEntry[];
  spreads?: PikalyticsSpreadEntry[];
  team?: PikalyticsRelatedPokemonEntry[];
  counters?: PikalyticsRelatedPokemonEntry[];
};

const PIKALYTICS_BASE_URL = 'https://www.pikalytics.com';
const PIKALYTICS_CURRENT_FORMAT = 'gen9championsvgc2026regmc';
const PIKALYTICS_RATING = '1760';
// The latest known Pikalytics data month. It is tried first,
// then recent months are probed newest-first so this does not have to change every month.
const PIKALYTICS_PREFERRED_DATE = '2026-09';
const DEFAULT_FORMAT: 'double' = 'double';
const HTTP_TIMEOUT_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;

let cache: MetaCache | undefined;
const detailCache = new Map<string, { generatedAt: number; detail: PikalyticsPokemonEntry }>();

const spread = (
  nature: string,
  hp: number,
  atk: number,
  def: number,
  spa: number,
  spd: number,
  spe: number,
  usage?: number,
  label?: string,
) => ({
  nature,
  sp: { hp, atk, def, spa, spd, spe } as StatTable,
  usage,
  label,
});

const FALLBACK_META: MetaPokemonSummary[] = [
  {
    pokemon: 'Flutter Mane',
    rank: 1,
    usage: 0.31,
    popularMoves: [{ move: 'Moonblast', usage: 0.86 }, { move: 'Shadow Ball', usage: 0.78 }, { move: 'Protect', usage: 0.61 }],
    popularItems: [{ item: 'Booster Energy', usage: 0.47 }, { item: 'Choice Specs', usage: 0.18 }],
    popularAbilities: [{ ability: 'Protosynthesis', usage: 1 }],
    popularSpreads: [spread('Timid', 0, 0, 0, 32, 2, 32, 0.28, 'fast special attacker'), spread('Modest', 0, 0, 2, 32, 0, 32, 0.16, 'max damage')],
  },
  {
    pokemon: 'Incineroar',
    rank: 2,
    usage: 0.29,
    popularMoves: [{ move: 'Fake Out', usage: 0.93 }, { move: 'Parting Shot', usage: 0.75 }, { move: 'Flare Blitz', usage: 0.68 }],
    popularItems: [{ item: 'Sitrus Berry', usage: 0.34 }, { item: 'Assault Vest', usage: 0.21 }],
    popularAbilities: [{ ability: 'Intimidate', usage: 0.99 }],
    popularSpreads: [spread('Careful', 32, 0, 0, 0, 32, 2, 0.24, 'special bulk'), spread('Impish', 32, 0, 32, 0, 2, 0, 0.14, 'physical bulk')],
  },
  {
    pokemon: 'Landorus-Therian',
    rank: 3,
    usage: 0.24,
    popularMoves: [{ move: 'Earthquake', usage: 0.74 }, { move: 'Stomping Tantrum', usage: 0.41 }, { move: 'Rock Slide', usage: 0.36 }],
    popularItems: [{ item: 'Life Orb', usage: 0.21 }, { item: 'Choice Scarf', usage: 0.19 }],
    popularAbilities: [{ ability: 'Intimidate', usage: 1 }],
    popularSpreads: [spread('Adamant', 0, 32, 0, 0, 2, 32, 0.22, 'physical attacker'), spread('Jolly', 0, 32, 0, 0, 2, 32, 0.18, 'fast physical attacker')],
  },
  {
    pokemon: 'Urshifu-Rapid-Strike',
    rank: 4,
    usage: 0.22,
    popularMoves: [{ move: 'Surging Strikes', usage: 0.96 }, { move: 'Close Combat', usage: 0.89 }, { move: 'Aqua Jet', usage: 0.45 }],
    popularItems: [{ item: 'Mystic Water', usage: 0.29 }, { item: 'Choice Scarf', usage: 0.2 }],
    popularAbilities: [{ ability: 'Unseen Fist', usage: 1 }],
    popularSpreads: [spread('Jolly', 0, 32, 0, 0, 2, 32, 0.31, 'fast attacker'), spread('Adamant', 0, 32, 2, 0, 0, 32, 0.17, 'strong attacker')],
  },
  {
    pokemon: 'Sneasler',
    rank: 5,
    usage: 0.17,
    popularMoves: [{ move: 'Dire Claw', usage: 0.82 }, { move: 'Close Combat', usage: 0.76 }, { move: 'Protect', usage: 0.54 }],
    popularItems: [{ item: 'Psychic Seed', usage: 0.39 }, { item: 'Focus Sash', usage: 0.22 }],
    popularAbilities: [{ ability: 'Unburden', usage: 0.72 }, { ability: 'Poison Touch', usage: 0.28 }],
    popularSpreads: [spread('Adamant', 0, 32, 0, 0, 2, 32, 0.25, 'unburden attacker'), spread('Jolly', 0, 32, 0, 0, 2, 32, 0.18, 'maximum speed')],
  },
  {
    pokemon: 'Milotic',
    rank: 6,
    usage: 0.12,
    popularMoves: [{ move: 'Muddy Water', usage: 0.78 }, { move: 'Ice Beam', usage: 0.49 }, { move: 'Recover', usage: 0.45 }],
    popularItems: [{ item: 'Life Orb', usage: 0.19 }, { item: 'Leftovers', usage: 0.17 }],
    popularAbilities: [{ ability: 'Competitive', usage: 0.84 }, { ability: 'Marvel Scale', usage: 0.16 }],
    popularSpreads: [spread('Modest', 0, 0, 0, 32, 2, 32, 0.19, 'competitive attacker'), spread('Bold', 32, 0, 32, 0, 2, 0, 0.11, 'bulky support')],
  },
  {
    pokemon: 'Ursaluna-Bloodmoon',
    rank: 7,
    usage: 0.11,
    popularMoves: [{ move: 'Blood Moon', usage: 0.93 }, { move: 'Hyper Voice', usage: 0.77 }, { move: 'Earth Power', usage: 0.66 }],
    popularItems: [{ item: 'Throat Spray', usage: 0.39 }, { item: 'Life Orb', usage: 0.14 }],
    popularAbilities: [{ ability: "Mind's Eye", usage: 1 }],
    popularSpreads: [spread('Quiet', 32, 0, 0, 32, 2, 0, 0.25, 'trick room attacker'), spread('Modest', 32, 0, 0, 32, 2, 0, 0.12, 'bulky attacker')],
  },
];

/** Reset the in-memory cache (used in tests). */
export function resetMetaCache(): void {
  cache = undefined;
  detailCache.clear();
}

export async function getMetaSnapshot(
  request: GetMetaSnapshotRequest = {},
): Promise<GetMetaSnapshotResponse> {
  const limit = request.limit ?? 20;
  const includeBuilds = request.includeBuilds ?? true;
  const meta = await loadMeta(request);
  const pokemon = meta.data.slice(0, limit).map(entry =>
    includeBuilds ? { ...entry } : { pokemon: entry.pokemon, usage: entry.usage, rank: entry.rank },
  );

  return {
    format: 'pokemon-champions',
    generatedAt: new Date().toISOString(),
    source: meta.source,
    pokemon,
  };
}

export async function getPokemonOptions(
  request: GetPokemonOptionsRequest,
): Promise<GetPokemonOptionsResponse> {
  const meta = await loadMeta(request);
  const resolution = resolveMetaEntry(meta, request.pokemon);
  const target = resolution.entry;
  const inputCorrections: InputCorrection[] = [...resolution.corrections];
  const effectiveName = target?.pokemon ?? resolveShowdownSpecies(request.pokemon)?.name ?? request.pokemon;
  const preferredSlug = target
    ? meta.slugByPokemon.get(target.pokemon.toLowerCase())
    : undefined;

  const resolved = meta.provider === 'pikalytics'
    ? await fetchPikalyticsDetailForName(effectiveName, meta, preferredSlug).catch(() => undefined)
    : undefined;
  const slug = resolved?.slug ?? preferredSlug ?? candidateSlugsForPokemon(effectiveName)[0];
  const detail = resolved?.detail;
  const detailSummary = detail ? summaryFromPikalyticsEntry(detail, target?.rank) : undefined;
  const entry =
    detailSummary && target
      ? mergeDetailIntoSummary(target, detailSummary)
      : detailSummary
        ? detailSummary
        : target ?? {
          pokemon: normalizedDisplayNameForUnresolvedRequest(effectiveName),
          popularMoves: [],
          popularItems: [],
          popularAbilities: [],
          popularSpreads: [],
        };

  const requestedMega = getCanonicalMegaAbility(effectiveName);
  const optionEntry = requestedMega
    ? {
        ...entry,
        pokemon: requestedMega.species,
        popularAbilities: [{ ability: requestedMega.ability, usage: 1 }],
      }
    : withCanonicalMegaAbility(entry);

  // Detail pages may only exist for a less specific forme (e.g. requested
  // 'basculegion-female' but only 'basculegion' has a page). Never do this silently.
  const requestedSlug = toPokeChamDbSlug(effectiveName);
  const formFallback =
    detail && resolved && resolved.slug !== requestedSlug && requestedSlug.startsWith(`${resolved.slug}-`)
      ? { requestedSlug, usedSlug: resolved.slug }
      : undefined;
  if (formFallback) {
    inputCorrections.push({
      code: 'formeDataFallback',
      path: 'pokemon',
      from: requestedSlug,
      to: formFallback.usedSlug,
      reason: `Pikalytics has no page for '${requestedSlug}'; returned data is for base forme '${formFallback.usedSlug}' and may not reflect the requested forme.`,
    });
  }
  const suggestions =
    !target && !detail
      ? suggestPokemonNames(request.pokemon, meta.data.map(candidate => candidate.pokemon))
      : [];

  const response: GetPokemonOptionsResponse = {
    ...(inputCorrections.length ? { inputCorrections } : {}),
    pokemon: optionEntry.pokemon,
    moves: (optionEntry.popularMoves ?? []).map(({ move, usage }) => ({ name: move, usage })),
    items: (optionEntry.popularItems ?? []).map(({ item, usage }) => ({ name: item, usage })),
    abilities: (optionEntry.popularAbilities ?? []).map(({ ability, usage }) => ({ name: ability, usage })),
    spreads: optionEntry.popularSpreads ?? [],
    builds: (optionEntry.popularSpreads ?? []).slice(0, 3).map((popularSpread, index) => ({
      label: popularSpread.label ?? `Common build ${index + 1}`,
      pokemon: {
        name: optionEntry.pokemon,
        nature: popularSpread.nature,
        ability: optionEntry.popularAbilities?.[0]?.ability,
        abilitySource: requestedMega ? 'mega-default' : undefined,
        item: optionEntry.popularItems?.[0]?.item,
        sp: popularSpread.sp,
      },
      moves: optionEntry.popularMoves?.slice(0, 4).map(move => move.move),
      usage: popularSpread.usage,
    })),
    metaNotes: buildMetaNotes({
      requestPokemon: request.pokemon,
      effectiveName,
      source: meta.source,
      targetFound: Boolean(target),
      detailFound: Boolean(detail),
      slug,
      requestedMega,
      formFallback,
      suggestions,
      corrections: inputCorrections,
    }),
  };

  if (request.includeTeammates) {
    response.teammates = detail?.team?.length
      ? detail.team.map(relatedPokemonToUsage).filter((entry): entry is PokemonOptionUsage => Boolean(entry))
      : meta.data
          .filter(candidate => candidate.pokemon !== optionEntry.pokemon)
          .slice(0, 5)
          .map(candidate => ({ name: candidate.pokemon, usage: candidate.usage }));
  }
  if (request.includeCounters) {
    response.counters = detail?.counters?.length
      ? detail.counters.map(relatedPokemonToUsage).filter((entry): entry is PokemonOptionUsage => Boolean(entry))
      : meta.data
          .filter(candidate => candidate.pokemon !== optionEntry.pokemon)
          .slice(-5)
          .map(candidate => ({ name: candidate.pokemon, usage: candidate.usage }));
  }

  return response;
}

/**
 * Resolve a Pokémon name against the current Pokémon Champions meta without fetching detail data.
 *
 * This is used by calc tool handlers as a guardrail for LLM tool calls that submit a bare base
 * species even though the current format lists exactly one specific forme. It intentionally only
 * returns a changed name when {@link resolveMetaEntry} produced an explicit correction; exact
 * base-species matches and unresolved names are left to the local calc resolver.
 */
export async function resolvePokemonNameForCurrentMeta(
  request: Pick<GetPokemonOptionsRequest, 'pokemon' | 'format'>,
): Promise<{ pokemon: string; inputCorrections?: InputCorrection[]; source: string }> {
  const meta = await loadMeta(request);
  const resolution = resolveMetaEntry(meta, request.pokemon);
  if (resolution.entry && resolution.corrections.length) {
    return {
      pokemon: resolution.entry.pokemon,
      inputCorrections: resolution.corrections,
      source: meta.source,
    };
  }
  return { pokemon: request.pokemon, source: meta.source };
}

async function loadMeta(request: Pick<GetMetaSnapshotRequest, 'format'> = {}): Promise<MetaCache> {
  const format = normalizeFormat(request.format ?? DEFAULT_FORMAT);
  // Pikalytics' gen9championsvgc2026regmc key is the Champions M-C Showdown doubles ladder. A `single` request is
  // currently treated as the default Champions ladder instead of attempting an unrelated BSS key.
  const cacheKeyMatches = cache?.provider === 'pikalytics' && cache.source.includes(`format=${PIKALYTICS_CURRENT_FORMAT}`);
  if (cache && cacheKeyMatches && Date.now() - cache.generatedAt < CACHE_MS) return cache;

  try {
    cache = await fetchPikalyticsRanking({ format });
    return cache;
  } catch {
    cache = buildFallbackCache('bundled fallback meta seed (Pikalytics unavailable)');
    return cache;
  }
}

async function fetchPikalyticsRanking(_params: { format: 'single' | 'double' }): Promise<MetaCache> {
  const key = `${PIKALYTICS_CURRENT_FORMAT}-${PIKALYTICS_RATING}`;
  const errors: string[] = [];
  for (const date of candidatePikalyticsDates()) {
    const period = { date, key, format: PIKALYTICS_CURRENT_FORMAT, rating: PIKALYTICS_RATING };
    const url = pikalyticsListUrl(period);
    try {
      const payload = await fetchJson<unknown>(url);
      if (!Array.isArray(payload) || !payload.length) {
        errors.push(`${date}: empty/unavailable`);
        continue;
      }
      return buildPikalyticsCache(payload as PikalyticsPokemonEntry[], period, url);
    } catch (error) {
      errors.push(`${date}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Pikalytics ranking data not found. Tried ${errors.join('; ')}`);
}

function buildPikalyticsCache(entries: PikalyticsPokemonEntry[], period: PikalyticsPeriod, url: string): MetaCache {
  const slugByPokemon = new Map<string, string>();
  const displayByPokemon = new Map<string, string>();
  const detailByPokemon = new Map<string, PikalyticsPokemonEntry>();
  const data = entries.map((entry, index): MetaPokemonSummary => {
    const pokemon = pikalyticsDisplayName(entry);
    const slug = pikalyticsSlugForName(pokemon);
    slugByPokemon.set(pokemon.toLowerCase(), slug);
    displayByPokemon.set(pokemon.toLowerCase(), pokemon);
    detailByPokemon.set(pokemon.toLowerCase(), entry);
    detailByPokemon.set(slug.toLowerCase(), entry);
    return summaryFromPikalyticsEntry(entry, index + 1);
  });

  return {
    generatedAt: Date.now(),
    data,
    source: `Pikalytics live date=${period.date} format=${period.format} rating=${period.rating} (${url})`,
    provider: 'pikalytics',
    slugByPokemon,
    displayByPokemon,
    detailByPokemon,
    period,
  };
}

async function fetchPikalyticsDetail(
  slug: string,
  meta: MetaCache,
): Promise<PikalyticsPokemonEntry> {
  const period = meta.period;
  if (!period) throw new Error('Pikalytics period is unavailable.');

  const cachedInList = meta.detailByPokemon.get(slug.toLowerCase());
  if (cachedInList) return cachedInList;

  const key = `${period.date}:${period.key}:${slug}`;
  const cached = detailCache.get(key);
  if (cached && Date.now() - cached.generatedAt < CACHE_MS) return cached.detail;

  const url = pikalyticsPokemonUrl(period, slug);
  const payload = await fetchJson<unknown>(url);
  if (!isPikalyticsPokemonEntry(payload)) throw new Error(`Pikalytics detail unavailable for ${slug}.`);
  detailCache.set(key, { generatedAt: Date.now(), detail: payload });
  return payload;
}

async function fetchPikalyticsDetailForName(
  pokemon: string,
  meta: MetaCache,
  preferredSlug?: string,
): Promise<{ slug: string; detail: PikalyticsPokemonEntry } | undefined> {
  const candidates = preferredSlug
    ? [preferredSlug, ...candidateSlugsForPokemon(pokemon).filter(slug => slug !== preferredSlug)]
    : candidateSlugsForPokemon(pokemon);

  for (const slug of candidates) {
    try {
      const detail = await fetchPikalyticsDetail(slug, meta);
      return { slug, detail };
    } catch {
      // Try less-specific variants, e.g. basculegion-female -> basculegion,
      // garchomp-mega -> garchomp. A genuine outage will fall through to no detail.
    }
  }
  return undefined;
}

function summaryFromPikalyticsEntry(entry: PikalyticsPokemonEntry, fallbackRank?: number): MetaPokemonSummary {
  const pokemon = pikalyticsDisplayName(entry);
  return withCanonicalMegaAbility({
    pokemon,
    rank: parseOptionalInteger(entry.ranking ?? entry.rank) ?? fallbackRank,
    popularMoves: (entry.moves ?? [])
      .filter(move => typeof move.move === 'string')
      .map(move => ({ move: move.move ?? '', usage: percentToUsage(move.percent) })),
    popularItems: (entry.items ?? [])
      .filter(item => typeof item.item === 'string')
      .map(item => ({ item: item.item ?? '', usage: percentToUsage(item.percent) })),
    popularAbilities: (entry.abilities ?? [])
      .filter(ability => typeof ability.ability === 'string')
      .map(ability => ({ ability: ability.ability ?? '', usage: percentToUsage(ability.percent) })),
    popularSpreads: extractPikalyticsSpreads(entry),
  });
}

function mergeDetailIntoSummary(summary: MetaPokemonSummary, detail: MetaPokemonSummary): MetaPokemonSummary {
  return withCanonicalMegaAbility({
    ...summary,
    popularMoves: detail.popularMoves?.length ? detail.popularMoves : summary.popularMoves,
    popularItems: detail.popularItems?.length ? detail.popularItems : summary.popularItems,
    popularAbilities: detail.popularAbilities?.length ? detail.popularAbilities : summary.popularAbilities,
    popularSpreads: detail.popularSpreads?.length ? detail.popularSpreads : summary.popularSpreads,
  });
}

function withCanonicalMegaAbility(summary: MetaPokemonSummary): MetaPokemonSummary {
  const mega = getCanonicalMegaAbility(summary.pokemon);
  if (!mega) return summary;
  return {
    ...summary,
    pokemon: mega.species,
    popularAbilities: [{ ability: mega.ability, usage: 1 }],
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await axios.get<T>(url, {
    timeout: HTTP_TIMEOUT_MS,
    responseType: 'json',
    headers: {
      'User-Agent': 'pokemon-battle-mcp/0.1 (+https://www.pikalytics.com)',
      Accept: 'application/json,text/plain,*/*',
    },
  });
  return response.data;
}

function candidatePikalyticsDates(): string[] {
  const dates: string[] = [];
  const add = (date: string) => {
    if (/^\d{4}-\d{2}$/.test(date) && !dates.includes(date)) dates.push(date);
  };
  add(PIKALYTICS_PREFERRED_DATE);

  const current = new Date();
  // Pikalytics data can lag the current month, so search a generous recent window.
  for (let offset = 0; offset < 18; offset += 1) {
    const month = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - offset, 1));
    add(`${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return dates;
}

function pikalyticsListUrl(period: PikalyticsPeriod): string {
  return `${PIKALYTICS_BASE_URL}/api/p/${period.date}/${period.key}`;
}

function pikalyticsPokemonUrl(period: PikalyticsPeriod, slug: string): string {
  return `${pikalyticsListUrl(period)}/${encodeURIComponent(slug)}`;
}

function normalizeFormat(format: string | undefined): 'single' | 'double' {
  return format === 'single' || format === 'singles' ? 'single' : 'double';
}

function percentToUsage(percent: string | number | undefined): number | undefined {
  const value = typeof percent === 'number' ? percent : Number(percent);
  return Number.isFinite(value) ? Math.round((value / 100) * 10_000) / 10_000 : undefined;
}

function parseOptionalInteger(value: string | number | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function pikalyticsDisplayName(entry: PikalyticsPokemonEntry): string {
  const raw = entry.display_name || entry.name_trans || entry.name || '';
  const species = resolveShowdownSpecies(raw);
  if (species) return species.name;
  return titleCaseSlug(nameKey(raw));
}

function pikalyticsRelatedDisplayName(entry: PikalyticsRelatedPokemonEntry): string | undefined {
  const raw = entry.pokemon_trans || entry.pokemon || entry.name;
  if (!raw) return undefined;
  const species = resolveShowdownSpecies(raw);
  return species?.name ?? titleCaseSlug(nameKey(raw));
}

function relatedPokemonToUsage(entry: PikalyticsRelatedPokemonEntry): PokemonOptionUsage | undefined {
  const name = pikalyticsRelatedDisplayName(entry);
  return name ? { name, usage: percentToUsage(entry.percent) } : undefined;
}

function pikalyticsSlugForName(name: string): string {
  return toPokeChamDbSlug(name);
}

function isPikalyticsPokemonEntry(payload: unknown): payload is PikalyticsPokemonEntry {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload));
}

function extractPikalyticsSpreads(entry: PikalyticsPokemonEntry): MetaSpread[] {
  const defaultNature = entry.natures?.find(nature => nature.nature)?.nature ?? 'Hardy';
  const spreads: MetaSpread[] = [];
  for (const [index, rawSpread] of (entry.spreads ?? []).entries()) {
    if (typeof rawSpread.ev !== 'string') continue;
    const parts = rawSpread.ev.split('/').map(value => Number(value));
    if (parts.length !== 6 || parts.some(value => !Number.isInteger(value))) continue;
    const [hp, atk, def, spa, spd, spe] = parts;
    const sp = { hp, atk, def, spa, spd, spe } as StatTable;
    if (Object.values(sp).some(value => value < 0 || value > 32)) continue;
    if (Object.values(sp).reduce((sum, value) => sum + value, 0) > 66) continue;
    spreads.push({
      nature: rawSpread.nature || defaultNature,
      sp,
      usage: percentToUsage(rawSpread.percent),
      label: `Pikalytics SP spread rank ${index + 1}`,
    });
  }
  return spreads;
}

type MetaEntryResolution = {
  entry?: MetaPokemonSummary;
  corrections: InputCorrection[];
};

/** All comparable keys for one meta entry (English name, URL slug, display name). */
function metaEntryNames(meta: MetaCache, entry: MetaPokemonSummary): string[] {
  return [
    entry.pokemon,
    meta.slugByPokemon.get(entry.pokemon.toLowerCase()),
    meta.displayByPokemon.get(entry.pokemon.toLowerCase()),
  ].filter((name): name is string => Boolean(name));
}

/**
 * Match a requested name against the meta ranking.
 *
 * 1. Exact match on any accepted spelling (Showdown name/alias, URL slug, display name).
 * 2. Forme upgrade: if the input names a base species and the meta lists exactly one of its
 *    formes (e.g. 'Floette' -> 'Floette-Mega'), resolve to it with an input correction.
 *    Multiple candidate formes raise an ambiguity error instead of guessing.
 */
function resolveMetaEntry(meta: MetaCache, pokemon: string): MetaEntryResolution {
  const showdown = resolveShowdownSpecies(pokemon);
  const inputKeys = new Set<string>([nameKey(pokemon), squashedKey(pokemon)]);
  if (showdown) {
    inputKeys.add(nameKey(showdown.name));
    inputKeys.add(squashedKey(showdown.name));
  }

  const exact = meta.data.find(entry =>
    metaEntryNames(meta, entry).some(
      name => inputKeys.has(nameKey(name)) || inputKeys.has(squashedKey(name)),
    ),
  );
  if (exact) return { entry: exact, corrections: [] };

  const baseKey = nameKey(showdown?.name ?? pokemon);
  const formeMatches = meta.data.filter(entry =>
    metaEntryNames(meta, entry).some(name => nameKey(name).startsWith(`${baseKey}-`)),
  );
  if (formeMatches.length === 1) {
    const entry = formeMatches[0];
    return {
      entry,
      corrections: [
        {
          code: 'formeResolved',
          path: 'pokemon',
          from: pokemon,
          to: entry.pokemon,
          reason: `The current meta lists only '${entry.pokemon}' for '${pokemon}'; resolved to that forme.`,
        },
      ],
    };
  }
  if (formeMatches.length > 1) {
    throw new UserInputError(
      `'${pokemon}' is ambiguous in the current meta. Candidates: ${formeMatches
        .map(entry => entry.pokemon)
        .join(', ')}. Specify one of these formes.`,
    );
  }
  return { corrections: [] };
}

function normalizedDisplayNameForUnresolvedRequest(name: string): string {
  const candidates = candidateSlugsForPokemon(name);
  return titleCaseSlug(candidates[0] ?? nameKey(name));
}

function buildMetaNotes(args: {
  requestPokemon: string;
  effectiveName: string;
  source: string;
  targetFound: boolean;
  detailFound: boolean;
  slug?: string;
  requestedMega?: { species: string; ability: string };
  formFallback?: { requestedSlug: string; usedSlug: string };
  suggestions?: string[];
  corrections?: InputCorrection[];
}): string[] {
  const notes = [
    args.targetFound || args.detailFound
      ? `Using ${args.source}.`
      : `No meta entry found for ${args.requestPokemon}; tried Pikalytics slugs '${candidateSlugsForPokemon(args.effectiveName).join("', '")}'.`,
    'Pikalytics Pokémon Champions Regulation M-C Showdown data is used; labels are returned in English.',
    'SP spreads use Pokémon Champions limits: 0-32 per stat and 66 total.',
  ];
  if (!args.targetFound && !args.detailFound && args.suggestions?.length) {
    notes.splice(1, 0, `Did you mean: ${args.suggestions.join(', ')}?`);
  }
  if (args.slug && args.slug !== nameKey(args.requestPokemon)) {
    notes.splice(1, 0, `Resolved requested name '${args.requestPokemon}' to Pikalytics slug '${args.slug}'.`);
  }
  if (args.formFallback) {
    notes.splice(
      1,
      0,
      `Warning: Pikalytics has no data page for '${args.formFallback.requestedSlug}'; the returned moves/items/spreads are for base forme '${args.formFallback.usedSlug}' and may not reflect the requested forme.`,
    );
  }
  for (const correction of args.corrections ?? []) {
    if (correction.code === 'formeResolved') {
      notes.splice(
        1,
        0,
        `Resolved '${String(correction.from)}' to '${String(correction.to)}': ${correction.reason}`,
      );
    }
  }
  if (args.requestedMega) {
    notes.splice(
      1,
      0,
      `Requested Mega forme '${args.requestedMega.species}' has fixed ability '${args.requestedMega.ability}'; ability options and builds use the Mega ability even if moves/items/spreads come from base-form meta data.`,
    );
  }
  return notes;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function buildFallbackCache(source: string): MetaCache {
  const slugByPokemon = new Map<string, string>();
  const detailByPokemon = new Map<string, PikalyticsPokemonEntry>();
  for (const entry of FALLBACK_META) {
    const slug = toPokeChamDbSlug(entry.pokemon);
    slugByPokemon.set(entry.pokemon.toLowerCase(), slug);
    detailByPokemon.set(entry.pokemon.toLowerCase(), {
      name: entry.pokemon,
      ranking: entry.rank,
      moves: entry.popularMoves?.map(move => ({ move: move.move, percent: usageToPercent(move.usage) })),
      items: entry.popularItems?.map(item => ({ item: item.item, percent: usageToPercent(item.usage) })),
      abilities: entry.popularAbilities?.map(ability => ({ ability: ability.ability, percent: usageToPercent(ability.usage) })),
    });
  }
  return {
    generatedAt: Date.now(),
    data: FALLBACK_META,
    source,
    provider: 'fallback',
    slugByPokemon,
    displayByPokemon: new Map(),
    detailByPokemon,
  };
}

function usageToPercent(usage: number | undefined): string | undefined {
  return usage === undefined ? undefined : String(usage * 100);
}
