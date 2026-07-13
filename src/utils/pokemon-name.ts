/**
 * Shared Pokémon name resolution (single source of truth for both data paths).
 *
 * The server consumes two data sources with different naming conventions:
 *   - Pokémon Showdown data via @pkmn/dex (calc tools): abbreviated formes,
 *     e.g. `Basculegion-F`, `Landorus-Therian`, `Charizard-Mega-X`.
 *   - Live meta tools: PokeAPI-style URL slugs with full-word formes,
 *     e.g. `basculegion-female`, `urshifu-rapid-strike`.
 *
 * This module accepts any common spelling (either convention, Showdown aliases,
 * spaces/punctuation variants) and converts to whichever canonical form a caller
 * needs. Unknown names produce did-you-mean suggestions.
 */

import { Dex } from '@pkmn/dex';
import { Generations, toID, type GenerationNum } from '@pkmn/data';

export const GENERATION: GenerationNum = 9;

const gens = new Generations(Dex, d => !!d.exists);
export const gen = gens.get(GENERATION);

/** Thrown for invalid user-provided input (bad species/move/SP). Surfaced as a tool error. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

export function id(value: string | undefined): string {
  return toID(value ?? '');
}

export type DexSpecies = NonNullable<ReturnType<typeof gen.species.get>>;

/**
 * Lowercase hyphen-token key with punctuation stripped and trailing gender
 * abbreviations expanded: `Basculegion-F` -> `basculegion-female`,
 * `Rotom Wash` -> `rotom-wash`, `Sirfetch'd` -> `sirfetchd`.
 *
 * This is also the live meta provider slug format.
 */
export function nameKey(name: string): string {
  const tokens = name
    .trim()
    .toLowerCase()
    .replace(/['’().]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && (last === 'f' || last === 'm')) {
    tokens[tokens.length - 1] = last === 'f' ? 'female' : 'male';
  }
  return tokens.join('-');
}

/** `nameKey` without separators; loose comparison key. */
export function squashedKey(name: string): string {
  return nameKey(name).replace(/-/g, '');
}

/** Spelling variants to try against the Showdown dex (which also knows Showdown aliases). */
function dexLookupVariants(name: string): string[] {
  const variants: string[] = [name];
  const key = nameKey(name);
  variants.push(key);
  const tokens = key.split('-');
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1) {
    // Full-word gender forms back to Showdown abbreviations:
    // basculegion-female -> basculegion-f; basculegion-male -> basculegion-m (alias of base).
    if (last === 'female') variants.push([...tokens.slice(0, -1), 'f'].join('-'));
    if (last === 'male') variants.push([...tokens.slice(0, -1), 'm'].join('-'));
  }
  return variants;
}

/**
 * Resolve any common spelling to a Showdown dex species, or undefined.
 * Accepts Showdown names, Showdown aliases, and PokeAPI/provider-style slugs.
 */
export function resolveShowdownSpecies(name: string): DexSpecies | undefined {
  for (const variant of dexLookupVariants(name)) {
    const species = gen.species.get(id(variant) as never);
    if (species) return species;
  }
  return undefined;
}

/** Like {@link resolveShowdownSpecies} but throws a UserInputError with suggestions. */
export function requireShowdownSpecies(name: string, extraNames: string[] = []): DexSpecies {
  const species = resolveShowdownSpecies(name);
  if (species) return species;
  const suggestions = suggestPokemonNames(name, extraNames);
  const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
  throw new UserInputError(`Unknown Pokémon species: ${name}.${hint}`);
}

/**
 * Canonical live-provider slug for a name. Resolves through the Showdown dex first so
 * `Basculegion-F` and `basculegion-female` both map to `basculegion-female`, and
 * `Basculegion-Male` (a Showdown alias of the base forme) maps to `basculegion`.
 */
export function toPokeChamDbSlug(name: string): string {
  const species = resolveShowdownSpecies(name);
  return nameKey(species?.name ?? name);
}

/**
 * Ordered live-provider slug candidates, most specific first. Later entries are lossy
 * fallbacks (base forme); callers must surface a warning when one of those is used.
 */
export function candidateSlugsForPokemon(name: string): string[] {
  const candidates: string[] = [];
  const add = (slug: string) => {
    const cleaned = slug.replace(/^-+|-+$/g, '');
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };

  add(toPokeChamDbSlug(name));
  add(nameKey(name));

  const tokens = nameKey(name).split('-').filter(Boolean);
  const removableSuffixes = new Set([
    'male',
    'female',
    'mega',
    'megax',
    'megay',
    'x',
    'y',
    'z',
    'gmax',
    'gigantamax',
  ]);

  // Basculegion-Male -> basculegion; Indeedee-Female -> indeedee.
  const stripped = [...tokens];
  while (stripped.length > 1 && removableSuffixes.has(stripped[stripped.length - 1])) {
    stripped.pop();
    add(stripped.join('-'));
  }

  // Garchomp-Mega, Charizard-Mega-X/Y -> base species.
  const megaIndex = tokens.indexOf('mega');
  if (megaIndex > 0) add(tokens.slice(0, megaIndex).join('-'));

  // Last resort: bare first token (Rotom-Wash -> rotom is tried only after rotom-wash).
  if (tokens.length > 1) add(tokens[0]);

  return candidates;
}

/**
 * Did-you-mean suggestions for an unresolvable name, drawn from all Showdown species
 * plus any extra names (e.g. the current meta snapshot).
 */
export function suggestPokemonNames(input: string, extraNames: string[] = [], max = 5): string[] {
  const needle = squashedKey(input);
  if (!needle) return [];
  const pool = new Map<string, string>(); // squashed key -> display name
  for (const species of gen.species) pool.set(squashedKey(species.name), species.name);
  for (const name of extraNames) {
    const key = squashedKey(name);
    if (!pool.has(key)) pool.set(key, name);
  }

  const maxDistance = Math.max(2, Math.floor(needle.length / 3));
  const scored: Array<{ name: string; score: number }> = [];
  for (const [key, display] of pool) {
    let score: number;
    if (key === needle) score = 0;
    else if (key.startsWith(needle) || needle.startsWith(key)) {
      score = Math.abs(key.length - needle.length) * 0.5;
    } else {
      score = levenshtein(needle, key, maxDistance);
    }
    if (score <= maxDistance) scored.push({ name: display, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map(entry => entry.name);
}

/** Bounded Levenshtein distance; returns `limit + 1` when the distance exceeds `limit`. */
function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}
