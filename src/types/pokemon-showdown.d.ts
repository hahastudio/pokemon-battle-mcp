declare module 'pokemon-showdown' {
  type ShowdownDex = {
    data: {
      Pokedex: Record<string, unknown>;
      TypeChart: Record<string, unknown>;
      [table: string]: unknown;
    };
  };

  const PokemonShowdown: {
    Dex: {
      mod(mod: string): ShowdownDex;
    };
  };

  export default PokemonShowdown;
}
