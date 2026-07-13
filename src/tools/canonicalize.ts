import type { BattlePokemon, InputCorrection } from '../types';
import { resolvePokemonNameForCurrentMeta } from '../services/meta-source';
import { combineInputCorrections, inputCorrectionBreakdown } from '../utils/calc';
import { nameKey, resolveShowdownSpecies, squashedKey } from '../utils/pokemon-name';

/**
 * Tool-layer canonicalization for calc-oriented tools.
 *
 * The pure calc engine intentionally stays deterministic and local. Tool handlers, however, are
 * invoked in a Pokémon Champions/current-format context, so they can consult the current meta
 * when an LLM submitted a bare base species that is represented by exactly one ranked forme
 * (for example `Floette` -> `Floette-Mega`).
 */
export async function canonicalizeBattlePokemonForCalcTool(
  battlePokemon: BattlePokemon,
  battlePokemonPath: string,
  format?: 'single' | 'double' | 'singles' | 'doubles',
): Promise<{ pokemon: BattlePokemon; inputCorrections?: InputCorrection[] }> {
  const name = battlePokemon.pokemon.name;
  if (!shouldConsultCurrentMetaForForme(name)) return { pokemon: battlePokemon };

  const resolution = await resolvePokemonNameForCurrentMeta({ pokemon: name, format });
  if (!resolution.inputCorrections?.length || resolution.pokemon === name) {
    return { pokemon: battlePokemon };
  }

  const inputCorrections = resolution.inputCorrections.map(correction => ({
    ...correction,
    path: correction.path === 'pokemon' ? `${battlePokemonPath}.pokemon.name` : correction.path,
  }));

  return {
    pokemon: {
      ...battlePokemon,
      pokemon: {
        ...battlePokemon.pokemon,
        name: resolution.pokemon,
      },
    },
    inputCorrections,
  };
}

function shouldConsultCurrentMetaForForme(name: string): boolean {
  const species = resolveShowdownSpecies(name);
  if (!species) return false;
  if (species.forme) return false;
  if (!species.otherFormes?.length) return false;

  // Only treat a bare canonical base-species name as eligible. Explicit form-ish inputs such as
  // `Basculegion-Male` should not be upgraded to another forme just because the current ranking
  // has one matching suffix.
  const inputKey = nameKey(name);
  const speciesKey = nameKey(species.name);
  return inputKey === speciesKey || squashedKey(name) === squashedKey(species.name);
}

export function mergeInputCorrectionsIntoResponse<
  T extends { inputCorrections?: InputCorrection[]; modifierBreakdown?: string[] },
>(response: T, extraCorrections: Array<InputCorrection[] | undefined>): T {
  const inputCorrections = combineInputCorrections(...extraCorrections, response.inputCorrections);
  if (!inputCorrections) return response;

  const prependedBreakdown = combineInputCorrections(...extraCorrections);
  return {
    ...response,
    inputCorrections,
    ...(response.modifierBreakdown && prependedBreakdown
      ? {
          modifierBreakdown: [
            ...inputCorrectionBreakdown(prependedBreakdown),
            ...response.modifierBreakdown,
          ],
        }
      : {}),
  };
}
