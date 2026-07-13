/**
 * Shared types for the Pokémon Champions MCP server.
 *
 * These mirror the type definitions in Architecture.md (section 3.0) and the per-tool
 * request/response shapes in sections 3.1 - 3.8.
 */

export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type NonHPStatID = Exclude<StatID, 'hp'>;
export type StatTable = Record<StatID, number>;
export type PartialStatTable = Partial<StatTable>;

export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
export type BoostTable = Partial<Record<BoostID, number>>; // -6 to +6

export type Gender = 'male' | 'female' | 'genderless' | 'unknown';
export type DynamaxState = 'none' | 'dynamax' | 'gigantamax';
export type BattleFormat = 'singles' | 'doubles';

export type StatusCondition =
  | 'none'
  | 'burn'
  | 'paralysis'
  | 'sleep'
  | 'freeze'
  | 'poison'
  | 'toxic';

export type Weather = 'none' | 'sun' | 'rain' | 'sand' | 'snow';
export type Terrain = 'none' | 'electric' | 'grassy' | 'misty' | 'psychic';
export type EffectMode = 'auto' | 'active' | 'inactive';
export type AbilitySource = 'species-default' | 'mega-default' | 'battle-changed' | 'manual';

export type Relation = 'outspeed' | 'speedTie' | 'underspeed';
export type DamageRatioMode = 'min' | 'max' | 'average';

export type BattleEffectSource = 'ability' | 'item' | 'move' | 'field' | 'side' | 'manual';

export type InputCorrection = {
  /** Machine-readable correction kind, e.g. 'megaAbilityOverride'. */
  code: string;
  /** JSON path-like location in the request payload. */
  path: string;
  /** Original value. Null is used when the field was omitted. */
  from?: unknown;
  /** Corrected value. */
  to?: unknown;
  reason: string;
};

export type BattleEffect = {
  /** Canonical ID, e.g. 'itemconsumed', 'flashfire', 'helpinghand', 'confusion', 'trickroom'. */
  id: string;
  source?: BattleEffectSource;
  active?: boolean; // default true
  duration?: number;
  params?: Record<string, unknown>;
};

export type ChampionPokemonState = {
  /**
   * Species / forme name, any common spelling (Showdown names/aliases or PokeAPI-style
   * slugs, e.g. 'Basculegion-F' or 'basculegion-female'). Cosmetic gender should NOT be
   * encoded in name; gender-based formes (Basculegion-F, Indeedee-F, ...) are formes.
   */
  name: string;
  gender?: Gender;

  /** Pokémon Champions ability points, 0-32 per stat. Solver tools may leave target stat variable. */
  sp: PartialStatTable;

  nature: string;
  item?: string;
  ability?: string;
  /**
   * Declares how to interpret `ability`. Mega formes are auto-canonicalized unless this is
   * 'battle-changed' or 'manual'. Use 'battle-changed' for Skill Swap, Worry Seed, etc.
   */
  abilitySource?: AbilitySource;
  teraType?: string;
  dynamax?: DynamaxState;
};

export type PokemonBattleState = {
  /** Stat stages only. Not Tailwind / Swift Swim / Choice Scarf. */
  boosts?: BoostTable;
  status?: StatusCondition;

  /**
   * Number of this Pokémon's allies that have fainted so far.
   * Used by effects such as Last Respects and Supreme Overlord. If omitted, tools may use the
   * corresponding side state's `alliesFainted`.
   */
  alliesFainted?: number;

  /**
   * Number of times this Pokémon has been hit by a direct-damaging move during the battle.
   * Used by Rage Fist. Multi-hit moves count once per hit; confusion/substitute/non-damaging
   * effects should not be included.
   */
  timesHitByDirectDamage?: number;

  /** Controls whether the speed/damage-relevant ability/item effect should be inferred or forced. */
  abilityEffect?: EffectMode;
  itemEffect?: EffectMode;

  /** Individual triggered effects: itemconsumed, flashfire, helpinghand, charge, crit, etc. */
  activeEffects?: BattleEffect[];

  /** Individual temporary conditions: confusion, taunt, encore, substitute, leechseed, etc. */
  volatileConditions?: BattleEffect[];
};

export type BattlePokemon = {
  pokemon: ChampionPokemonState;
  state?: PokemonBattleState;
};

export type SideState = {
  /** tailwind, reflect, lightscreen, auroraveil, safeguard, mist, rainbow, seaoffire, swamp, etc. */
  sideConditions?: BattleEffect[];

  /**
   * Number of Pokémon fainted on this side. For `check_damage_matchup`, Last Respects uses
   * `context.attackerSide.alliesFainted` unless `attacker.state.alliesFainted` is set.
   */
  alliesFainted?: number;
};

export type FieldState = {
  weather?: Weather;
  terrain?: Terrain;

  /** trickroom, gravity, wonderroom, magicroom, etc. */
  fieldConditions?: BattleEffect[];
};

export type BattleContext = {
  field?: FieldState;
  attackerSide?: SideState;
  defenderSide?: SideState;
  format?: BattleFormat;
};

export type SPBudget = {
  maxTotalSP?: number; // default 66
  reservedSP?: number; // default inferred from known SP
};

export type DamageThreshold = {
  mode: DamageRatioMode;
  value: number; // e.g. 1.0 for 100% defender max HP
};

export type MetaSpread = {
  nature: string;
  sp: StatTable;
  usage?: number;
  label?: string;
};

export type ModifierBreakdown = string[];

/* --- 3.1 get_meta_snapshot --- */

export type GetMetaSnapshotRequest = {
  limit?: number; // default 20
  includeBuilds?: boolean; // default true
  /** Live meta format. Defaults to double. */
  format?: 'single' | 'double' | 'singles' | 'doubles';
};

export type MetaPokemonSummary = {
  pokemon: string;
  usage?: number;
  rank?: number;
  popularMoves?: Array<{ move: string; usage?: number }>;
  popularItems?: Array<{ item: string; usage?: number }>;
  popularAbilities?: Array<{ ability: string; usage?: number }>;
  popularSpreads?: MetaSpread[];
};

export type GetMetaSnapshotResponse = {
  format: 'pokemon-champions';
  generatedAt: string; // ISO timestamp
  source?: string;
  pokemon: MetaPokemonSummary[];
};

/* --- 3.2 get_pokemon_options --- */

export type GetPokemonOptionsRequest = {
  pokemon: string;
  includeTeammates?: boolean;
  includeCounters?: boolean;
  /** Live meta format. Defaults to double. */
  format?: 'single' | 'double' | 'singles' | 'doubles';
};

export type PokemonOptionUsage = {
  name: string;
  usage?: number;
};

export type PokemonBuildOption = {
  label?: string;
  pokemon: ChampionPokemonState;
  moves?: string[];
  usage?: number;
};

export type GetPokemonOptionsResponse = {
  inputCorrections?: InputCorrection[];
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

/* --- 3.3 check_damage_matchup --- */

export type CheckDamageMatchupRequest = {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;
};

export type CheckDamageMatchupResponse = {
  inputCorrections?: InputCorrection[];
  damageRange: [number, number]; // min/max damage ratio of defender max HP
  damageRolls: number[];
  damageRollRatios: number[];
  koChance: number; // 0 to 1
  modifierBreakdown: ModifierBreakdown;
  description: string;
};

/* --- 3.4 optimize_offensive_spread --- */

export type OptimizeOffensiveSpreadRequest = {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;

  offensiveStat?: 'atk' | 'spa'; // inferred from move if omitted
  targetDamageRatio: DamageThreshold;
  allowedNatures?: string[];

  spBudget?: SPBudget & {
    maxStatSP?: number; // default 32
  };
};

export type OptimizeOffensiveSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  requiredSP: number;
  resultingDamageRange: [number, number];
  koChance: number;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};

/* --- 3.5 optimize_survival_spread --- */

export type OptimizeSurvivalSpreadRequest = {
  defender: BattlePokemon;
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

export type OptimizeSurvivalSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  recommendedSP: PartialStatTable;
  totalSPUsed: number;
  resultingDamageRange: [number, number];
  survives: boolean;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};

/* --- 3.6 optimize_speed_spread --- */

export type SpeedTarget =
  | { speed: number; battlePokemon?: never; benchmarkLabel?: string }
  | { speed?: never; battlePokemon: BattlePokemon; benchmarkLabel?: string };

export type OptimizeSpeedSpreadRequest = {
  self: BattlePokemon; // pokemon.sp.spe may be omitted or variable
  target: SpeedTarget;
  context?: BattleContext;

  relation: Relation;
  allowedNatures?: string[];

  spBudget?: SPBudget & {
    maxSpeedSP?: number; // default 32
  };
};

export type OptimizeSpeedSpreadResponse = {
  inputCorrections?: InputCorrection[];
  recommendedNature: string;
  requiredSpeedSP: number;
  resultingRawSpeed: number;
  resultingFinalSpeed: number;
  targetFinalSpeed: number;
  margin: number;
  modifierBreakdown: ModifierBreakdown;
  isFeasibleUnderBudget: boolean;
};

/* --- 3.7 get_speed_tiers --- */

export type SpeedTierFilter =
  | { type: 'pokemon'; values: string[] }
  | { type: 'effect'; ids: string[]; scope?: 'pokemon' | 'side' | 'field' }
  | { type: 'item'; values: string[] }
  | { type: 'ability'; values: string[] }
  | { type: 'tag'; values: string[] };

export type GetSpeedTiersRequest = {
  limit?: number; // default 50
  includeModifiers?: boolean; // default true
  filters?: SpeedTierFilter[];
};

export type SpeedTierEntry = {
  pokemon: BattlePokemon;
  context?: BattleContext;
  rawSpeed: number;
  finalSpeed: number;
  description: string;
  modifierBreakdown: ModifierBreakdown;
  source?: string;
};

export type GetSpeedTiersResponse = {
  generatedAt: string; // ISO timestamp
  tiers: SpeedTierEntry[];
};

/* --- 3.8 calculate_stats --- */

export type CalculateStatsRequest = {
  pokemon: BattlePokemon;
  context?: BattleContext;
};

export type CalculateStatsResponse = {
  inputCorrections?: InputCorrection[];
  rawStats: StatTable;
  modifiedStats?: StatTable;
  modifierBreakdown: ModifierBreakdown;
};
