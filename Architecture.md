# Pokémon Battle Helper MCP Server - Architecture Design

This repository implements a TypeScript **Model Context Protocol (MCP)** server for Pokémon Champions battle assistance. It exposes tools for current M-rule metagame lookup, Pokémon option lookup, Champions SP stat calculation, damage checks, speed-tier analysis, and inverse SP optimization.

This document is the canonical project architecture. `README.md` should remain a short usage guide and should not duplicate implementation details that belong here.

---

## 1. System Overview

```txt
+-------------------------------------------------------------+
|                         MCP Client                          |
|              Claude / ChatGPT / Codex / custom app          |
+-------------------------------------------------------------+
                              | MCP over stdio
                              v
+-------------------------------------------------------------+
|                    Pokémon Battle MCP Server                |
+-------------------------------------------------------------+
      |                       |                       |
      v                       v                       v
+-----------+           +-----------+           +-----------+
| Live Meta |           | Calc      |           | Inverse   |
| Source    |           | Engine    |           | Solver    |
+-----------+           +-----------+           +-----------+
      |                       |                       |
      v                       v                       v
 Pikalytics live       @smogon/calc             SP search
 doubles by default    + Champions SP rules      over 0..32
```

### 1.1 Pokémon Champions stat model

The server uses the Pokémon Champions stat model throughout:

- **Level**: fixed at `50`.
- **IVs**: fixed at `31` in all stats.
- **SP / Ability Points**:
  - each stat: integer `0..32`;
  - total per Pokémon: at most `66`;
  - calculator conversion: `1 SP = 8 EVs`.

Therefore the standard level-50 Pokémon formula matches the simplified Champions formula:

```txt
HP       = floor(Base + 75.5 + SP)
Non-HP   = floor(Base + 20.5 + SP) * Nature
```

---

## 2. Technology Stack

- Runtime: Node.js + TypeScript ESM.
- MCP SDK: `@modelcontextprotocol/sdk`.
- Damage/stat engine: `@smogon/calc/adaptable` with `@pkmn/data` wrapping a pinned
  Pokémon Showdown Champions dex as the data source.
  - `@pkmn/dmg` is not used because it is not published on npm.
  - `pokemon-showdown` is pinned to a verified Git commit because its npm releases and
    generated `@pkmn/dex` snapshots can lag behind live Pokémon Champions updates.
  - `src/data/champions-dex.ts` adapts Showdown's `Pokedex`/`TypeChart` table names to
    the `Species`/`Types` names expected by `@pkmn/data`, preserving the Champions mod.
- HTTP/live data: `axios`.
- Tool schema validation: `zod`.
- Build: `tsup` (esbuild-powered) bundles `src/index.ts` into a single executable `dist/index.js`, which lets source files use extensionless relative imports (`moduleResolution: "Bundler"` in `tsconfig.json`) while still producing a runnable Node ESM entry point. `tsc --noEmit` remains the type checker.
- Tests: `vitest`, including MCP stdio e2e tests with a real SDK `Client`.

---

## 3. File Structure

```txt
pokemon-battle-mcp/
├── Architecture.md
├── README.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts              # MCP server creation and stdio entry point
│   ├── types.ts              # TypeScript request/response and battle model types
│   ├── tools/
│   │   ├── common.ts         # MCP response wrappers
│   │   ├── schemas.ts        # Zod input/output schemas exposed through tools/list
│   │   ├── meta.ts           # get_meta_snapshot, get_pokemon_options
│   │   ├── damage.ts         # calculate_stats, check_damage_matchup, offensive/survival solvers
│   │   └── speed.ts          # optimize_speed_spread, get_speed_tiers
│   ├── services/
│   │   ├── meta-source.ts    # Pikalytics live source + bundled fallback support
│   │   ├── modifiers.ts      # Explicit battle-state speed modifier resolution
│   │   ├── solver.ts         # Exhaustive SP reverse search
│   │   └── speed.ts          # Deterministic speed calculation and speed tiers
│   └── utils/
│       └── calc.ts           # @smogon/calc wrapper and SP→EV conversion
└── tests/
    ├── mcp-e2e.test.ts       # Real MCP stdio client/server integration
    ├── server.test.ts        # Tool registration and handler smoke tests
    ├── meta.test.ts
    ├── damage.test.ts
    ├── speed.test.ts
    ├── solver.test.ts
    └── stats.test.ts
```

---

## 4. Live Meta Source

### 4.1 Default provider

The primary live provider is **Pikalytics**. Default request target:

```txt
https://www.pikalytics.com/api/p/{YYYY-MM}/battledataregmbs3-1760
https://www.pikalytics.com/api/p/{YYYY-MM}/battledataregmbs3-1760/garchomp
```

Defaults:

- `format key = battledataregmbs3` (Pokémon Champions Reg M-B S3 ranked ladder)
- `rating cutoff = 1760`
- `format = double`

Pikalytics returns English-ready JSON with rank, moves, items, abilities, natures, SP spreads, teammates, counters, and tournament teams. The list endpoint returns the full ranked dataset; the Pokémon endpoint is used as a direct lookup fallback.

The `{YYYY-MM}` data month is discovered at runtime. The service tries a preferred known-good month first, then probes recent months newest-first. Pikalytics returns the literal JSON value `false` for unavailable months, which makes this probing cheap and deterministic.

### 4.2 Runtime behavior

Pikalytics is the only live provider. Provider selection is not configurable.

Internal defaults:

- base URL: `https://www.pikalytics.com`;
- current format/rule: `battledataregmbs3` (kept as an internal constant and updated in code when the current regulation changes);
- rating cutoff: `1760`;
- preferred data month: `2026-05` (tried first, with automatic recent-month probing after it);
- default format: `double` when a request omits `format`;
- HTTP timeout: `8000 ms`.

`format` is accepted by the request body (`single`/`double`, with `singles`/`doubles` aliases), but Pikalytics' `battledataregmbs3` source is the Champions doubles ladder, so current live meta requests use that one dataset. Season/regulation is intentionally not part of the public request schema; the service always uses the current internal provider key.

### 4.3 Fallback behavior

If live fetch/parsing fails, the server falls back to a small bundled seed so tools still return well-formed data. Every meta response includes a `source` string indicating whether live Pikalytics data or fallback data was used.

### 4.4 Pokémon name normalization

All tools share one name resolver (`src/utils/pokemon-name.ts`) that bridges the two naming conventions in play:

- Showdown Champions data (used by the calc tools): abbreviated formes such as `Basculegion-F`, `Landorus-Therian`, plus Showdown aliases (`lando-t`).
- Pikalytics (used by the meta tools): URL slugs compatible with PokeAPI-style full-word formes such as `basculegion-female`, while some pages also accept abbreviated formes such as `basculegion-f`.

Any common spelling is accepted everywhere. The resolver canonicalizes through the Showdown dex (expanding/abbreviating gender suffixes as needed) and converts deterministically to provider slugs (`Basculegion-F` <-> `basculegion-female`; `Basculegion-Male` -> `basculegion`, since male is the base forme). Calc tools report material renames as `speciesNameNormalized` input corrections; unknown names raise errors with did-you-mean suggestions drawn from the dex and the current meta snapshot.

For `get_pokemon_options`, matching against the live ranking proceeds in this order:

1. Exact match on any accepted spelling (English name, slug, display name, Showdown name/alias).
2. Forme upgrade: a base-species request resolves to the only ranked forme (`Floette` -> `Floette-Mega`) with a `formeResolved` input correction; multiple ranked formes raise an ambiguity error listing candidates instead of guessing.
3. Detail lookup tries the canonical slug first, then progressively less-specific slugs (`rotom-wash` before `rotom`). If a less-specific page is used for a distinct requested forme, the response carries a `formeDataFallback` input correction and an explicit `metaNotes` warning — never a silent base-forme substitution.

If neither the ranking nor any candidate detail page resolves, the tool returns an empty option shell with `metaNotes` listing attempted slugs and did-you-mean suggestions.

When the request names a Mega forme, `get_pokemon_options` returns the canonical Mega forme name and fixed Mega ability even if Pikalytics only has base-form move/item/spread data. For example, `Lucario-Mega` returns `Adaptability`, and generated builds mark `abilitySource: 'mega-default'`.

---

## 5. Battle Model

The server separates battle data into three layers:

1. **Static Pokémon set**: species, nature, item, ability, tera type, SP, gender, dynamax state.
2. **Individual Pokémon battle state**: boosts, major status, triggered effects, volatile conditions.
3. **Side and field state**: Tailwind, Reflect, screens, weather, terrain, Trick Room, etc.

This mirrors simulator concepts (`Pokemon`, `Side`, `Field`) and prevents shared effects from being duplicated on Pokémon objects.

### 5.1 Shared types

The implementation types live in `src/types.ts`. Key types:

```ts
type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
type StatTable = Record<StatID, number>;
type PartialStatTable = Partial<StatTable>;

type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
type BoostTable = Partial<Record<BoostID, number>>;

type BattleFormat = 'singles' | 'doubles';
type Weather = 'none' | 'sun' | 'rain' | 'sand' | 'snow';
type Terrain = 'none' | 'electric' | 'grassy' | 'misty' | 'psychic';
type EffectMode = 'auto' | 'active' | 'inactive';
type AbilitySource = 'species-default' | 'mega-default' | 'battle-changed' | 'manual';

type InputCorrection = {
  code: string;
  path: string;
  from?: unknown;
  to?: unknown;
  reason: string;
};

type BattleEffect = {
  id: string;
  source?: 'ability' | 'item' | 'move' | 'field' | 'side' | 'manual';
  active?: boolean;
  duration?: number;
  params?: Record<string, unknown>;
};

type ChampionPokemonState = {
  name: string;
  gender?: 'male' | 'female' | 'genderless' | 'unknown';
  sp: PartialStatTable;
  nature: string;
  item?: string;
  ability?: string;
  abilitySource?: AbilitySource;
  teraType?: string;
  dynamax?: 'none' | 'dynamax' | 'gigantamax';
};

type PokemonBattleState = {
  boosts?: BoostTable;
  status?: 'none' | 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic';
  abilityEffect?: EffectMode;
  itemEffect?: EffectMode;
  activeEffects?: BattleEffect[];
  volatileConditions?: BattleEffect[];
};

type BattlePokemon = {
  pokemon: ChampionPokemonState;
  state?: PokemonBattleState;
};

type BattleContext = {
  field?: {
    weather?: Weather;
    terrain?: Terrain;
    fieldConditions?: BattleEffect[];
  };
  attackerSide?: { sideConditions?: BattleEffect[] };
  defenderSide?: { sideConditions?: BattleEffect[] };
  format?: BattleFormat;
};
```

### 5.2 Design rules

- `ChampionPokemonState` is static set data only.
- `PokemonBattleState` is individual battle history/state only.
- `SideState` is side-scoped effects such as Tailwind, Reflect, Light Screen, Aurora Veil.
- `FieldState` is global effects such as weather, terrain, Trick Room, Gravity, Magic Room.
- `BattleEffect.id` is string-based so new mechanics do not require schema changes.
- Internal resolvers translate this semantic model into `@smogon/calc` objects.
- Mega forme abilities are canonicalized by default before calculation. If the current ability was changed in battle (for example by Skill Swap or Worry Seed), clients must send the changed `pokemon.ability` with `pokemon.abilitySource: 'battle-changed'` or an active ability-change effect such as `{ id: 'abilitychanged' }`, `{ id: 'skillswap' }`, or `{ id: 'worryseed' }`. Use `abilityEffect: 'inactive'` for suppression effects such as Gastro Acid while keeping the actual ability name.

---

## 6. Tool Surface

All tools are registered in `src/index.ts` via `src/tools/*`. Every tool exposes both an input schema and an output schema through MCP `tools/list`. Successful calls return text JSON and `structuredContent`. Tool errors return `isError: true` and text content only, so SDK clients do not validate an error payload against the success output schema.

### 6.1 `get_meta_snapshot`

```ts
type GetMetaSnapshotRequest = {
  limit?: number;          // default 20
  includeBuilds?: boolean; // default true
  format?: 'single' | 'double' | 'singles' | 'doubles'; // default double
};

type MetaPokemonSummary = {
  pokemon: string;
  usage?: number;
  rank?: number;
  popularMoves?: Array<{ move: string; usage?: number }>;
  popularItems?: Array<{ item: string; usage?: number }>;
  popularAbilities?: Array<{ ability: string; usage?: number }>;
  popularSpreads?: MetaSpread[];
};

type GetMetaSnapshotResponse = {
  format: 'pokemon-champions';
  generatedAt: string;
  source?: string;
  pokemon: MetaPokemonSummary[];
};
```

### 6.2 `get_pokemon_options`

```ts
type GetPokemonOptionsRequest = {
  pokemon: string;         // any common spelling; normalized per section 4.4
  includeTeammates?: boolean;
  includeCounters?: boolean;
  format?: 'single' | 'double' | 'singles' | 'doubles'; // default double
};

type GetPokemonOptionsResponse = {
  inputCorrections?: InputCorrection[]; // formeResolved, formeDataFallback, ...
  pokemon: string;
  moves: Array<{ name: string; usage?: number }>;
  items: Array<{ name: string; usage?: number }>;
  abilities: Array<{ name: string; usage?: number }>;
  spreads: MetaSpread[];
  builds?: Array<{
    label?: string;
    pokemon: ChampionPokemonState;
    moves?: string[];
    usage?: number;
  }>;
  teammates?: Array<{ name: string; usage?: number }>;
  counters?: Array<{ name: string; usage?: number }>;
  metaNotes?: string[];
};
```

For Mega forme requests, `abilities` contains the fixed Mega ability with `usage: 1`, and generated builds use that ability even if the rest of the set data comes from a base-form meta page.

### 6.3 `calculate_stats`

```ts
type CalculateStatsRequest = {
  pokemon: BattlePokemon;
  context?: BattleContext;
};

type CalculateStatsResponse = {
  inputCorrections?: InputCorrection[];
  rawStats: StatTable;
  modifiedStats?: StatTable;
  modifierBreakdown: string[];
};
```

### 6.4 `check_damage_matchup`

```ts
type CheckDamageMatchupRequest = {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;
};

type CheckDamageMatchupResponse = {
  inputCorrections?: InputCorrection[];
  damageRange: [number, number];
  damageRolls: number[];
  damageRollRatios: number[];
  koChance: number;
  modifierBreakdown: string[];
  description: string;
};
```

### 6.5 `optimize_offensive_spread`

```ts
type OptimizeOffensiveSpreadRequest = {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;
  offensiveStat?: 'atk' | 'spa';
  targetDamageRatio: { mode: 'min' | 'max' | 'average'; value: number };
  allowedNatures?: string[];
  spBudget?: { maxTotalSP?: number; reservedSP?: number; maxStatSP?: number };
};

type OptimizeOffensiveSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  requiredSP: number;
  resultingDamageRange: [number, number];
  koChance: number;
  modifierBreakdown: string[];
  isFeasibleUnderBudget: boolean;
};
```

### 6.6 `optimize_survival_spread`

```ts
type OptimizeSurvivalSpreadRequest = {
  defender: BattlePokemon;
  attacker: BattlePokemon;
  move: string;
  context?: BattleContext;
  defensiveStat?: 'def' | 'spd';
  survivalThreshold?: { maxDamageRatioLessThan?: number };
  allowedNatures?: string[];
  spBudget?: { maxTotalSP?: number; reservedSP?: number; maxHPSP?: number; maxDefenseSP?: number };
};

type OptimizeSurvivalSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  recommendedSP: PartialStatTable;
  totalSPUsed: number;
  resultingDamageRange: [number, number];
  survives: boolean;
  modifierBreakdown: string[];
  isFeasibleUnderBudget: boolean;
};
```

### 6.7 `optimize_speed_spread`

```ts
type SpeedTarget =
  | { speed: number; battlePokemon?: never; benchmarkLabel?: string }
  | { speed?: never; battlePokemon: BattlePokemon; benchmarkLabel?: string };

type OptimizeSpeedSpreadRequest = {
  self: BattlePokemon;
  target: SpeedTarget;
  context?: BattleContext;
  relation: 'outspeed' | 'speedTie' | 'underspeed';
  allowedNatures?: string[];
  spBudget?: { maxTotalSP?: number; reservedSP?: number; maxSpeedSP?: number };
};

type OptimizeSpeedSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  requiredSpeedSP: number;
  resultingRawSpeed: number;
  resultingFinalSpeed: number;
  targetFinalSpeed: number;
  margin: number;
  modifierBreakdown: string[];
  isFeasibleUnderBudget: boolean;
};
```

### 6.8 `get_speed_tiers`

```ts
type GetSpeedTiersRequest = {
  limit?: number;             // default 50
  includeModifiers?: boolean; // default true
  filters?: SpeedTierFilter[];
};

type SpeedTierFilter =
  | { type: 'pokemon'; values: string[] }
  | { type: 'effect'; ids: string[]; scope?: 'pokemon' | 'side' | 'field' }
  | { type: 'item'; values: string[] }
  | { type: 'ability'; values: string[] }
  | { type: 'tag'; values: string[] };

type GetSpeedTiersResponse = {
  generatedAt: string;
  tiers: Array<{
    pokemon: BattlePokemon;
    context?: BattleContext;
    rawSpeed: number;
    finalSpeed: number;
    description: string;
    modifierBreakdown: string[];
    source?: string;
  }>;
};
```

---

## 7. Calculation and Modifier Resolution

### 7.1 Damage/stat engine

`src/utils/calc.ts` wraps `@smogon/calc/adaptable` with `@pkmn/data` backed by the
pinned Pokémon Showdown Champions dex adapter as the data layer:

- validates SP (`0..32` each, total `<=66`);
- converts SP to EVs (`SP * 8`);
- fixes level to `50` and IVs to `31`;
- translates `BattlePokemon` and `BattleContext` into calc `Pokemon`, `Move`, `Field`, and `Side` objects;
- returns exact damage rolls, HP ratios, KO chance, and calc description.

### 7.2 Explicit battle-state assumptions

The calculator can apply many static item/ability effects when the Pokémon object contains the names. It cannot infer battle history. Therefore these must be explicit.

Mega forme ability normalization happens before stat, speed, damage, and solver calculations:

- Missing or stale abilities on Mega formes are replaced with the fixed Mega ability, and the response includes `inputCorrections` plus a matching line in `modifierBreakdown`.
- If the current ability was changed by battle history, send the changed ability and mark it explicitly, e.g. `abilitySource: 'battle-changed'` with `state.activeEffects: [{ id: 'worryseed', source: 'move' }]`. The server then respects the submitted ability.
- If the ability is merely suppressed, keep the actual ability and use `state.abilityEffect: 'inactive'`.

Other history-dependent effects must also be explicit:

- Intimidated attacker: `state.boosts.atk = -1`.
- Competitive triggered: `state.boosts.spa = 2`.
- Helping Hand: `state.activeEffects = [{ id: 'helpinghand' }]`.
- Critical hit: `state.activeEffects = [{ id: 'crit' }]`.
- Unburden active: `abilityEffect: 'active'` or `activeEffects: [{ id: 'itemconsumed' }]`.
- Booster/Paradox speed boost: `activeEffects: [{ id: 'boosterspeed' }]` or forced ability effect.

### 7.3 Speed calculation

Speed is computed in deterministic integer layers:

```txt
rawSpeed     = Champions stat formula
stagedSpeed  = apply Speed stage (-6..+6)
finalSpeed   = floor(stagedSpeed * rational non-stage modifiers)
```

Non-stage speed modifiers include Tailwind, Choice Scarf, Iron Ball, Swift Swim, Chlorophyll, Sand Rush, Slush Rush, Surge Surfer, Unburden, Protosynthesis/Quark Drive speed boost, Booster Energy speed boost, Swamp, and paralysis.

Trick Room is reported in the breakdown but does not change final Speed; it changes move-order interpretation.

---

## 8. Solver Design

The solver module uses exhaustive search over the small SP space:

- offensive stat: `0..maxStatSP` for each allowed nature;
- survival: HP `0..maxHPSP` × Def/SpD `0..maxDefenseSP` for each allowed nature;
- speed: Speed `0..maxSpeedSP` for each allowed nature.

Budget defaults:

- max total SP: `66`;
- max per optimized stat: `32`;
- reserved SP defaults to known SP outside the optimized stats.

If no candidate satisfies the target under budget, the best evaluated candidate is returned with `isFeasibleUnderBudget: false`.

---

## 9. Test Strategy

The test suite covers:

- Champions stat formula and SP validation;
- deterministic speed modifier layering;
- forward damage calculations and side/field translation;
- inverse solvers;
- meta fallback behavior;
- MCP server registration;
- MCP stdio e2e behavior with a real SDK `Client`:
  - `tools/list` exposes useful input/output schemas;
  - a client can call tools over stdio;
  - handler-level errors return MCP tool error results without invalid structured output;
  - invalid input is rejected by schema validation.

`npm test` runs `npm run typecheck` and `npm run build` first so e2e tests always start the current, type-checked `dist/index.js`.

### 9.1 Updating Pokémon Showdown data

The Pokémon Showdown dependency is a commit-addressed GitHub source archive. To take a
Champions data update:

1. Review upstream commits affecting `data/pokedex.ts`, `data/items.ts`, and
   `data/mods/champions/**`.
2. Replace the commit SHA in the `pokemon-showdown` archive URL in `package.json`.
3. Run `npm install` to refresh `package-lock.json` and build the pinned source.
4. Add or update a sentinel test in `tests/champions-dex.test.ts` for the changed data.
5. Run `npm test`; merge the dependency pin and lockfile together.

Do not point the dependency at a moving branch. A reviewed SHA makes each install reproducible
and prevents unreviewed simulator changes from entering calculations.
