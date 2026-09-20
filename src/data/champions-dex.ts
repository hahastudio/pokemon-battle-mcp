/**
 * Pokémon Champions data from a pinned Pokémon Showdown source revision.
 *
 * Pokémon Showdown and @pkmn/data expose the same underlying records under
 * different table names. The small adapter below supplies the names expected by
 * @pkmn/data while retaining Showdown's Champions mod for species, items, moves,
 * abilities, learnsets, and legality metadata.
 */

import PokemonShowdown from 'pokemon-showdown';
import { Generation, type GenerationNum } from '@pkmn/data';
import type { Dex as PkmnDex } from '@pkmn/dex-types';

export const GENERATION: GenerationNum = 9;

const showdownDex = PokemonShowdown.Dex.mod('champions');
const showdownData = showdownDex.data;
const adaptedData = {
  ...showdownData,
  Species: showdownData.Pokedex,
  Types: showdownData.TypeChart,
};

/**
 * @pkmn/data reads `dex.data.Species` and `dex.data.Types`; Pokémon Showdown
 * names those tables `Pokedex` and `TypeChart`. All other operations stay bound
 * to the original Champions ModdedDex through this proxy.
 */
const dex = new Proxy(showdownDex, {
  get(target, property, receiver) {
    if (property === 'data') return adaptedData;
    return Reflect.get(target, property, receiver);
  },
}) as unknown as PkmnDex;

// Construct Generation directly. Generations#get(9) calls dex.forGen(9), which
// would replace the Champions mod with the ordinary Gen 9 mod.
export const gen = new Generation(dex, data => !!data.exists);

