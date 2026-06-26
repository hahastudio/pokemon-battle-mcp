# Pokémon Battle Helper MCP Server - Architecture Design (Pokémon Champions Edition)

This Model Context Protocol (MCP) server provides a set of tools to assist competitive Pokémon VGC players under the **Pokémon Champions (宝可梦冠军赛)** ruleset. It helps in team building, speed tier analysis, and damage calculation optimization by using the game's unique **Ability Points (能力点数 / SP)** system.

---

## 1. System Overview

The server acts as an intermediary between LLMs (like Claude, ChatGPT) and Pokémon competitive database & simulation libraries. It translates high-level tactical questions into programmatic iterations and damage formulas.

```
+-------------------------------------------------------------+
|                        LLM / Client                         |
+-------------------------------------------------------------+
                              | (MCP Protocol)
                              v
+-------------------------------------------------------------+
|                      Pokémon MCP Server                     |
+-------------------------------------------------------------+
      |                       |                       |
      v                       v                       v
+-----------+           +-----------+           +-----------+
|   Meta    |           | Calc      |           | Inverse   |
|   Data    |           | Engine    |           |  Module   |
|  Module   |           | (Showdown)|           |  (Solver) |
+-----------+           +-----------+           +-----------+
      |                       |                       |
      v                       v                       v
[poch.ms/Pikalytics]    [@pkmn/dmg / calc]      [SP Optimization]
```

### 1.1 Pokémon Champions Ruleset Adaptations
Under the Pokémon Champions ruleset (`poch.ms`), stats calculation is modernized and simplified:
- **Level**: Fixed at **50** for all Pokémon.
- **IVs (个体值)**: Fixed at **31** (perfect) in all stats.
- **Ability Points (能力点数 / SP / AP)**: Replaces traditional Effort Values (EVs).
  - Each stat can be allocated **0 to 32 SP**.
  - A Pokémon can have a maximum of **66 SP** in total across all 6 stats.
  - **Conversion Formula**: `1 SP = 8 EVs` in the standard Showdown calculator.
  - Since `EV = 8 * SP`, standard formulas perfectly hold:
    - `Stat = floor(Base + 20.5 + SP) * Nature` (for non-HP stats)
    - `HP = floor(Base + 75.5 + SP)` (for HP)

---

## 2. Core Modules

### 2.1 Meta Data Module
Responsible for retrieving up-to-date competitive metagame statistics.
- **Data Sources**:
  - **poch.ms / Pikalytics API**: Fetching popular builds, movesets, items, abilities, and popular SP spreads.
- **Key Functions**:
  - `getPopularBuilds(pokemon: string)`: Returns top movesets, common SP spreads (e.g., `32/0/0/32/0/2`), items, and abilities.
  - `getMetaPokemonList()`: Returns top-tier Pokémon in the current meta.

### 2.2 Calculation Engine (Wrapper)
Wraps standard Pokémon Showdown libraries to calculate exact in-battle stats and damage ranges.
- **Dependencies**:
  - `@pkmn/data` (for Pokémon, moves, items, abilities data)
  - `@pkmn/dmg` (damage calculation math)
- **Key Functions**:
  - `calculateStats(pokemon: BattlePokemon, context?: BattleContext)`: Calculates raw and optionally modified stats using SP (0-32).
  - `calculateDamage(attacker: BattlePokemon, defender: BattlePokemon, move: string, context?: BattleContext)`: Returns exact damage rolls, damage ratios, KO chance, and modifier breakdown.
- **Battle Context Support**:
  - **Pokémon state**: Handles boosts, major status, volatile conditions, and individual triggered effects.
  - **Side state**: Handles Tailwind, Reflect, Light Screen, Aurora Veil, rainbow, swamp, etc.
  - **Field state**: Handles weather, terrain, Trick Room, Gravity, Magic Room, etc.
  - **Static set data**: Items, abilities, Tera type, gender, and Dynamax/Gigantamax state are part of `ChampionPokemonState`.

### 2.3 Inverse Solver Module (The Core "Smart" Layer)
Runs *backward* to find optimal SP spreads. Since SP only ranges from 0 to 32, the search space per stat is extremely small (33 options), making the optimization algorithm incredibly fast and robust.

- **Speed Solver (`findSpeedSP`)**:
  - Finds the minimum Speed SP and appropriate nature to outspeed, tie, or underspeed a target using `BattlePokemon` + `BattleContext`.
- **Offensive Damage Solver (`findMinOffensiveSP`)**:
  - Finds the minimum Atk/SpA SP and nature required to achieve a target damage ratio against a defender under full `BattleContext`.
- **Defensive Damage Solver (`findOptimalDefensiveSP`)**:
  - Solves the optimal allocation of HP and Def/SpD SP to keep max damage ratio below the requested survival threshold.

---

## 3. MCP Tools Definition

The MCP Server uses a three-layer battle model:

1. **Pokémon static set** — what this Pokémon is.
2. **Pokémon battle state** — effects attached only to this individual Pokémon.
3. **Side / field state** — effects attached to one side or the whole battlefield.

This mirrors the way battle simulators conceptually separate `Pokemon`, `Side`, and `Field`, and prevents duplicated state across attacker and defender.

### 3.0 Shared Types

```ts
type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
type StatTable = Record<StatID, number>;
type PartialStatTable = Partial<StatTable>;

type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
type BoostTable = Partial<Record<BoostID, number>>; // -6 to +6

type Gender = 'male' | 'female' | 'genderless' | 'unknown';
type DynamaxState = 'none' | 'dynamax' | 'gigantamax';
type BattleFormat = 'singles' | 'doubles';

type StatusCondition =
  | 'none'
  | 'burn'
  | 'paralysis'
  | 'sleep'
  | 'freeze'
  | 'poison'
  | 'toxic';

type Weather = 'none' | 'sun' | 'rain' | 'sand' | 'snow';
type Terrain = 'none' | 'electric' | 'grassy' | 'misty' | 'psychic';
type EffectMode = 'auto' | 'active' | 'inactive';

type Relation = 'outspeed' | 'speedTie' | 'underspeed';
type DamageRatioMode = 'min' | 'max' | 'average';

type BattleEffectSource = 'ability' | 'item' | 'move' | 'field' | 'side' | 'manual';

type BattleEffect = {
  /** Canonical ID, e.g. 'itemconsumed', 'flashfire', 'helpinghand', 'confusion', 'trickroom'. */
  id: string;
  source?: BattleEffectSource;
  active?: boolean; // default true
  duration?: number;
  params?: Record<string, unknown>;
};

type ChampionPokemonState = {
  /** Species / forme name. Gender should NOT be encoded in name. */
  name: string;
  gender?: Gender;

  /** Pokémon Champions ability points, 0-32 per stat. Solver tools may leave target stat variable. */
  sp: PartialStatTable;

  nature: string;
  item?: string;
  ability?: string;
  teraType?: string;
  dynamax?: DynamaxState; // Usually 'none' for Champions unless a format explicitly enables it.
};

type PokemonBattleState = {
  /** Stat stages only. Not Tailwind / Swift Swim / Choice Scarf. */
  boosts?: BoostTable;
  status?: StatusCondition;

  /** Controls whether the speed/damage-relevant ability/item effect should be inferred or forced. */
  abilityEffect?: EffectMode;
  itemEffect?: EffectMode;

  /** Individual triggered effects: itemconsumed, flashfire, helpinghand, charge, crit, etc. */
  activeEffects?: BattleEffect[];

  /** Individual temporary conditions: confusion, taunt, encore, substitute, leechseed, etc. */
  volatileConditions?: BattleEffect[];
};

type BattlePokemon = {
  pokemon: ChampionPokemonState;
  state?: PokemonBattleState;
};

type SideState = {
  /** tailwind, reflect, lightscreen, auroraveil, safeguard, mist, rainbow, seaoffire, swamp, etc. */
  sideConditions?: BattleEffect[];
};

type FieldState = {
  weather?: Weather;
  terrain?: Terrain;

  /** trickroom, gravity, wonderroom, magicroom, etc. */
  fieldConditions?: BattleEffect[];
};

type BattleContext = {
  field?: FieldState;
  attackerSide?: SideState;
  defenderSide?: SideState;
  format?: BattleFormat;
};

type SPBudget = {
  maxTotalSP?: number; // default 66
  reservedSP?: number; // default inferred from known SP
};

type DamageThreshold = {
  mode: DamageRatioMode;
  value: number; // e.g. 1.0 for 100% defender max HP
};

type MetaSpread = {
  nature: string;
  sp: StatTable;
  usage?: number;
  label?: string;
};

type ModifierBreakdown = string[];
```

Design rule:
- `ChampionPokemonState` describes the static set: species, gender, nature, item, ability, tera, Dynamax/Gigantamax state, and SP.
- `PokemonBattleState` describes only states attached to this Pokémon: boosts, status, confusion, item consumed, Helping Hand, etc.
- `SideState` describes side-scoped effects: Tailwind, Reflect, Light Screen, Aurora Veil, rainbow, etc.
- `FieldState` describes global battlefield effects: weather, terrain, Trick Room, Gravity, Magic Room, etc.
- `BattleEffect.id` is string-based so new mechanics do not require schema changes.
- Internal resolvers translate this semantic model into `@pkmn/dmg` / `@smogon/calc` objects.

---

### 3.1 `get_meta_snapshot`

Get the latest popular Pokémon, moves, items, abilities, and common SP spreads for the current Pokémon Champions format.

```ts
type GetMetaSnapshotRequest = {
  limit?: number; // default 20
  includeBuilds?: boolean; // default true
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
  generatedAt: string; // ISO timestamp
  source?: string;
  pokemon: MetaPokemonSummary[];
};
```

---

### 3.2 `get_pokemon_options`

Get common sets and tactical options for one Pokémon.

```ts
type GetPokemonOptionsRequest = {
  pokemon: string;
  includeTeammates?: boolean;
  includeCounters?: boolean;
};

type PokemonOptionUsage = {
  name: string;
  usage?: number;
};

type PokemonBuildOption = {
  label?: string;
  pokemon: ChampionPokemonState;
  moves?: string[];
  usage?: number;
};

type GetPokemonOptionsResponse = {
  pokemon: string;
  moves: PokemonOptionUsage[];
  items: PokemonOptionUsage[];
  abilities: PokemonOptionUsage[];
  spreads: MetaSpread[];
  builds?: PokemonBuildOption[];
  teammates?: PokemonOptionUsage[];
  counters?: PokemonOptionUsage[];
  metaNotes?: string[];
};
```

---

### 3.3 `check_damage_matchup`

Run a forward damage calculation.

```ts
type CheckDamageMatchupRequest = {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;
};

type CheckDamageMatchupResponse = {
  damageRange: [number, number]; // min/max damage ratio of defender max HP, e.g. [0.916, 1.093]
  damageRolls: number[];
  damageRollRatios: number[];
  koChance: number; // 0 to 1
  modifierBreakdown: ModifierBreakdown;
  description: string;
};
```

Notes:
- Static item / ability names are resolved by the calc engine.
- Triggered individual effects must be represented in `PokemonBattleState`, e.g. `boosts.atk = -1`, `activeEffects: [{ id: 'helpinghand' }]`.
- Side and field effects must be represented in `BattleContext`, not duplicated on both Pokémon.

---

### 3.4 `optimize_offensive_spread`

Find the minimum offensive SP and nature needed to reach a damage threshold.

```ts
type OptimizeOffensiveSpreadRequest = {
  attacker: BattlePokemon; // attacking stat SP may be omitted or variable
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;

  offensiveStat?: 'atk' | 'spa'; // inferred from move if omitted
  targetDamageRatio: DamageThreshold; // e.g. { mode: 'min', value: 1.0 } for guaranteed OHKO
  allowedNatures?: string[];

  spBudget?: SPBudget & {
    maxStatSP?: number; // default 32
  };
};

type OptimizeOffensiveSpreadResponse = {
  recommendedNature: string;
  requiredSP: number;
  resultingDamageRange: [number, number];
  koChance: number;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};
```

---

### 3.5 `optimize_survival_spread`

Find the minimum defensive SP allocation needed to survive a specified attack.

```ts
type OptimizeSurvivalSpreadRequest = {
  defender: BattlePokemon; // hp and relevant defensive stat SP may be omitted or variable
  attacker: BattlePokemon;
  move: string;
  context?: BattleContext;

  defensiveStat?: 'def' | 'spd'; // inferred from move if omitted
  survivalThreshold?: {
    maxDamageRatioLessThan?: number; // default 1.0
  };
  allowedNatures?: string[];

  spBudget?: SPBudget & {
    maxHPSP?: number; // default 32
    maxDefenseSP?: number; // default 32
  };
};

type OptimizeSurvivalSpreadResponse = {
  recommendedNature: string;
  recommendedSP: PartialStatTable;
  totalSPUsed: number;
  resultingDamageRange: [number, number];
  survives: boolean;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};
```

---

### 3.6 `optimize_speed_spread`

Find the minimum Speed SP and nature needed to outspeed, speed tie, or underspeed a target.

```ts
type SpeedTarget =
  | { speed: number; battlePokemon?: never; benchmarkLabel?: string }
  | { speed?: never; battlePokemon: BattlePokemon; benchmarkLabel?: string };

type OptimizeSpeedSpreadRequest = {
  self: BattlePokemon; // pokemon.sp.spe may be omitted or variable
  target: SpeedTarget;
  context?: BattleContext;

  relation: Relation;
  allowedNatures?: string[];

  spBudget?: SPBudget & {
    maxSpeedSP?: number; // default 32
  };
};

type OptimizeSpeedSpreadResponse = {
  recommendedNature: string;
  requiredSpeedSP: number;
  resultingRawSpeed: number;
  resultingFinalSpeed: number;
  targetFinalSpeed: number;
  margin: number;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};
```

Important speed rule:
- `state.boosts.spe` is only the Speed stage.
- Tailwind, Swift Swim, Unburden, Choice Scarf, Booster Energy, paralysis, etc. are resolved as separate modifiers from `PokemonBattleState` + `SideState` + `FieldState` + item/ability.

---

### 3.7 `get_speed_tiers`

Return sorted speed benchmarks in the current metagame.

```ts
type GetSpeedTiersRequest = {
  limit?: number; // default 50
  includeModifiers?: boolean; // default true

  /** Generic, future-proof filters. Avoid adding one boolean per mechanic. */
  filters?: SpeedTierFilter[];
};

type SpeedTierFilter =
  | { type: 'pokemon'; values: string[] }
  | { type: 'effect'; ids: string[]; scope?: 'pokemon' | 'side' | 'field' }
  | { type: 'item'; values: string[] }
  | { type: 'ability'; values: string[] }
  | { type: 'tag'; values: string[] };

type SpeedTierEntry = {
  pokemon: BattlePokemon;
  context?: BattleContext;
  rawSpeed: number;
  finalSpeed: number;
  description: string;
  modifierBreakdown: ModifierBreakdown;
  source?: string;
};

type GetSpeedTiersResponse = {
  generatedAt: string; // ISO timestamp
  tiers: SpeedTierEntry[];
};
```

---

### 3.8 `calculate_stats`

Calculate Pokémon Champions level-50 stats from species, nature, and SP.

```ts
type CalculateStatsRequest = {
  pokemon: BattlePokemon;
  context?: BattleContext;
};

type CalculateStatsResponse = {
  rawStats: StatTable;
  modifiedStats?: StatTable;
  modifierBreakdown: ModifierBreakdown;
};
```

---

### 3.9 Tool Call Examples

#### Example A: `check_damage_matchup` — Intimidated Landorus into Reflect

```json
{
  "attacker": {
    "pokemon": {
      "name": "Landorus-Therian",
      "gender": "male",
      "nature": "Adamant",
      "ability": "Intimidate",
      "item": "Life Orb",
      "teraType": "Ground",
      "dynamax": "none",
      "sp": { "hp": 0, "atk": 32, "def": 0, "spa": 0, "spd": 0, "spe": 32 }
    },
    "state": {
      "boosts": { "atk": -1 },
      "status": "none"
    }
  },
  "defender": {
    "pokemon": {
      "name": "Incineroar",
      "gender": "male",
      "nature": "Careful",
      "ability": "Intimidate",
      "item": "Sitrus Berry",
      "dynamax": "none",
      "sp": { "hp": 32, "atk": 0, "def": 16, "spa": 0, "spd": 18, "spe": 0 }
    },
    "state": { "status": "none" }
  },
  "move": "Earthquake",
  "context": {
    "format": "doubles",
    "field": { "weather": "none", "terrain": "none" },
    "defenderSide": {
      "sideConditions": [{ "id": "reflect", "source": "move" }]
    }
  }
}
```

#### Example B: `optimize_offensive_spread` — Milotic Competitive under Rain

```json
{
  "attacker": {
    "pokemon": {
      "name": "Milotic",
      "gender": "female",
      "nature": "Modest",
      "ability": "Competitive",
      "item": "Life Orb",
      "sp": { "hp": 0, "atk": 0, "def": 0, "spd": 2, "spe": 32 }
    },
    "state": {
      "boosts": { "spa": 2 },
      "activeEffects": [{ "id": "competitive", "source": "ability" }]
    }
  },
  "defender": {
    "pokemon": {
      "name": "Incineroar",
      "gender": "male",
      "nature": "Careful",
      "ability": "Intimidate",
      "item": "Assault Vest",
      "sp": { "hp": 32, "atk": 0, "def": 0, "spa": 0, "spd": 32, "spe": 2 }
    }
  },
  "move": "Muddy Water",
  "context": {
    "format": "doubles",
    "field": { "weather": "rain", "terrain": "none" }
  },
  "offensiveStat": "spa",
  "targetDamageRatio": { "mode": "min", "value": 1.0 },
  "allowedNatures": ["Modest", "Timid"],
  "spBudget": { "maxStatSP": 32, "maxTotalSP": 66 }
}
```

#### Example C: `optimize_survival_spread` — Survive Life Orb Earthquake

```json
{
  "defender": {
    "pokemon": {
      "name": "Incineroar",
      "gender": "male",
      "nature": "Careful",
      "ability": "Intimidate",
      "item": "Sitrus Berry",
      "sp": { "atk": 0, "spa": 0, "spd": 18, "spe": 0 }
    },
    "state": { "status": "none" }
  },
  "attacker": {
    "pokemon": {
      "name": "Landorus-Therian",
      "gender": "male",
      "nature": "Adamant",
      "ability": "Intimidate",
      "item": "Life Orb",
      "sp": { "hp": 0, "atk": 32, "def": 0, "spa": 0, "spd": 0, "spe": 32 }
    },
    "state": { "boosts": { "atk": -1 } }
  },
  "move": "Earthquake",
  "context": { "format": "doubles" },
  "defensiveStat": "def",
  "survivalThreshold": { "maxDamageRatioLessThan": 1.0 },
  "spBudget": { "maxHPSP": 32, "maxDefenseSP": 32, "maxTotalSP": 66 }
}
```

#### Example D: `optimize_speed_spread` — Unburden Sneasler vs Booster Flutter Mane

```json
{
  "self": {
    "pokemon": {
      "name": "Sneasler",
      "gender": "female",
      "nature": "Adamant",
      "ability": "Unburden",
      "item": "Psychic Seed",
      "sp": { "hp": 0, "atk": 32, "def": 0, "spa": 0, "spd": 2 }
    },
    "state": {
      "abilityEffect": "active",
      "activeEffects": [{ "id": "itemconsumed", "source": "item" }]
    }
  },
  "target": {
    "battlePokemon": {
      "pokemon": {
        "name": "Flutter Mane",
        "gender": "genderless",
        "nature": "Timid",
        "ability": "Protosynthesis",
        "item": "Booster Energy",
        "sp": { "hp": 0, "atk": 0, "def": 0, "spa": 32, "spd": 2, "spe": 32 }
      },
      "state": {
        "abilityEffect": "active",
        "activeEffects": [{ "id": "boosterspeed", "source": "item" }]
      }
    }
  },
  "context": {
    "format": "doubles",
    "field": { "weather": "none", "terrain": "psychic" }
  },
  "relation": "outspeed",
  "allowedNatures": ["Adamant", "Jolly"],
  "spBudget": { "maxSpeedSP": 32, "maxTotalSP": 66 }
}
```

#### Example E: `optimize_speed_spread` — Underspeed in Trick Room

```json
{
  "self": {
    "pokemon": {
      "name": "Ursaluna-Bloodmoon",
      "gender": "male",
      "nature": "Quiet",
      "ability": "Mind's Eye",
      "item": "Throat Spray",
      "sp": { "hp": 32, "atk": 0, "def": 0, "spa": 32, "spd": 2 }
    }
  },
  "target": {
    "battlePokemon": {
      "pokemon": {
        "name": "Incineroar",
        "gender": "male",
        "nature": "Careful",
        "ability": "Intimidate",
        "sp": { "hp": 32, "atk": 0, "def": 0, "spa": 0, "spd": 32, "spe": 2 }
      }
    }
  },
  "context": {
    "format": "doubles",
    "field": {
      "weather": "none",
      "terrain": "none",
      "fieldConditions": [{ "id": "trickroom", "source": "field" }]
    }
  },
  "relation": "underspeed",
  "allowedNatures": ["Quiet"]
}
```

## 4. Modifier Resolution Design

A key architectural rule: **names are not always enough**. Item names and ability names can be resolved by the calculation library, but only after the MCP server provides the correct battle state.

### 4.1 What Libraries Can Resolve Automatically
Damage libraries such as `@pkmn/dmg` / `@smogon/calc` can correctly apply many item and ability effects when they are explicitly present on the Pokémon object:
- Damage items: Life Orb, Choice Band, Choice Specs, type-boosting items, plates, feathers, etc.
- Damage abilities: Adaptability, Fairy Aura, Tough Claws, Technician, etc.
- Defensive abilities/items: Thick Fat, Filter, Friend Guard, Assault Vest, Eviolite, etc.
- Field effects: weather, terrain, screens, aura effects when represented in the field/context.

However, they **do not infer battle history** from names alone. For example:
- If the defender has `Intimidate`, the calculator does not automatically know the attacker has already been intimidated.
- If the attacker has `Competitive`, the calculator does not automatically know it was triggered by Intimidate.
- If the attacker has `Unburden`, the calculator does not automatically know its item was consumed.

Therefore, the MCP server must separate **static set data** from **dynamic battle state**.

### 4.2 Battle State Model
The server intentionally separates battle state into three layers, as defined in **Section 3**:

- `PokemonBattleState`: individual Pokémon state, such as boosts, major status, confusion, item consumed, Flash Fire active, Helping Hand, etc.
- `SideState`: one-side state, such as Tailwind, Reflect, Light Screen, Aurora Veil, rainbow, sea of fire, swamp, Safeguard, Mist, etc.
- `FieldState`: global battlefield state, such as weather, terrain, Trick Room, Gravity, Wonder Room, and Magic Room.

This split avoids duplicating shared effects on both attacker and defender. For example:
- Reflect belongs to `context.defenderSide.sideConditions`, not the defender Pokémon.
- Tailwind belongs to the relevant side, not the Pokémon.
- Rain and Electric Terrain belong to `context.field`.
- Burn, paralysis, confusion, item consumed, and Flash Fire active belong to the individual Pokémon.

The solver may provide convenience presets such as:
- `assumeIntimidated: true` -> attacker `state.boosts.atk = -1`.
- `assumeCompetitiveTriggered: true` -> attacker `state.boosts.spa = +2`.
- `abilityEffect: 'active'` with `ability: 'Unburden'` -> speed modifier `x2` if the resolver accepts the forced active state.

But these are explicit battle-state assumptions, not derived blindly from ability names.

### 4.3 Speed Modifier Model
Speed abilities and items are **not speed stages**.

For example:
- `Swift Swim` under rain is **speed x2**, not `speedStage +2`.
- `Unburden` after item consumption is **speed x2**, not `speedStage +2`.
- `Choice Scarf` is **speed x1.5**, not `speedStage +1`.
- `Tailwind` is **speed x2**, not `speedStage +2`.

This matters because stages cap at `+6`, but non-stage modifiers stack on top of staged speed.

Example:
```txt
Base calculated Speed = 100
Speed stage +6 = 100 * 4 = 400
Swift Swim active = 400 * 2 = 800
Tailwind active = 800 * 2 = 1600
```

So a Pokémon at `+6` Speed can still be further doubled by Swift Swim, Unburden, Tailwind, etc.

The speed engine should compute speed in layers:

```ts
rawSpeed = calculateChampionStat(baseSpeed, speedSP, nature);
stagedSpeed = applyStatStage(rawSpeed, speedStage);      // -6 to +6
modifiedSpeed = applySpeedModifiers(stagedSpeed, [
  hasSideCondition(sideState, 'tailwind') ? 2 : 1,
  choiceScarfActive ? 1.5 : 1,
  swiftSwimActive ? 2 : 1,
  unburdenActive ? 2 : 1,
  pokemonState.status === 'paralysis' ? 0.5 : 1,
]);
finalSpeed = floorWithGameRules(modifiedSpeed);
```

The implementation should use deterministic integer modifier math instead of loose floating-point multiplication, because one point of Speed can decide the turn order.

---

## 5. Technical Implementation & Flow

### 5.1 Technology Stack
- **Runtime**: Node.js (TypeScript)
- **SDK**: `@modelcontextprotocol/sdk`
- **Simulation**: `@pkmn/dmg` and `@pkmn/data` (translating `SP` to `EV` by multiplying by 8, and fixing `IV` to 31, `level` to 50)
- **Scraping/Data**: Axios with local cache

### 5.2 File Structure
```txt
pokemon-battle-mcp/
├── package.json
├── tsconfig.json
├── Architecture.md
└── src/
    ├── index.ts              # MCP Server entry & registration
    ├── tools/
    │   ├── meta.ts           # Handles get_meta_snapshot, get_pokemon_options
    │   ├── damage.ts         # Handles check_damage_matchup, optimize_offensive/survival
    │   └── speed.ts          # Handles optimize_speed_spread, get_speed_tiers
    ├── services/
    │   ├── meta-source.ts    # poch.ms / Pikalytics / Smogon data source helpers
    │   ├── solver.ts         # Math logic for SP reverse search
    │   ├── modifiers.ts      # Explicit battle-state and modifier resolution
    │   └── speed.ts          # Deterministic speed calculation engine
    └── utils/
        └── calc.ts           # Wrapper for @pkmn/dmg (SP -> EV mapping)
```

---
