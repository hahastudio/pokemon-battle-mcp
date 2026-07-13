import { z } from 'zod';

const statIdValues = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const boostIdValues = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;

const spValueSchema = z
  .number()
  .int()
  .min(0)
  .max(32)
  .describe('Pokémon Champions SP for one stat, 0-32.');

export const PartialStatTableSchema = z
  .object({
    hp: spValueSchema.optional(),
    atk: spValueSchema.optional(),
    def: spValueSchema.optional(),
    spa: spValueSchema.optional(),
    spd: spValueSchema.optional(),
    spe: spValueSchema.optional(),
  })
  .describe('Partial Pokémon Champions SP table. Omitted stats default to 0.');

export const StatTableSchema = z
  .object({
    hp: spValueSchema,
    atk: spValueSchema,
    def: spValueSchema,
    spa: spValueSchema,
    spd: spValueSchema,
    spe: spValueSchema,
  })
  .describe('Complete Pokémon Champions SP table.');

const InputCorrectionSchema = z
  .object({
    code: z.string().min(1).describe("Machine-readable correction kind, e.g. 'megaAbilityOverride'."),
    path: z.string().min(1).describe('JSON path-like location in the request payload.'),
    from: z.unknown().optional().describe('Original value; null means the field was omitted.'),
    to: z.unknown().optional().describe('Corrected value.'),
    reason: z.string().min(1),
  })
  .describe('Server-side input normalization applied before calculation.');

const BoostTableSchema = z
  .object(Object.fromEntries(boostIdValues.map(stat => [stat, z.number().int().min(-6).max(6).optional()])))
  .describe('Pokémon stat stage table. Speed stages are not Tailwind/Swift Swim/Choice Scarf.');

const BattleEffectSchema = z
  .object({
    id: z.string().min(1).describe("Canonical effect ID, e.g. 'tailwind', 'reflect', 'itemconsumed'."),
    source: z.enum(['ability', 'item', 'move', 'field', 'side', 'manual']).optional(),
    active: z.boolean().optional().describe('Defaults to true.'),
    duration: z.number().int().optional(),
    params: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .describe('Future-proof string-ID battle effect.');

const ChampionPokemonStateSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "Species or forme name in any common spelling, e.g. 'Flutter Mane', 'Basculegion-F', 'basculegion-female', 'Landorus-Therian'. Names are normalized server-side; corrections are reported in inputCorrections. For current-format build/Mega requests, use the canonical name returned by get_pokemon_options when available.",
      ),
    gender: z.enum(['male', 'female', 'genderless', 'unknown']).optional(),
    sp: PartialStatTableSchema,
    nature: z.string().min(1).describe('Nature name, e.g. Timid, Adamant, Careful.'),
    item: z.string().optional(),
    ability: z.string().optional(),
    abilitySource: z
      .enum(['species-default', 'mega-default', 'battle-changed', 'manual'])
      .optional()
      .describe(
        "How to interpret ability. Mega formes auto-canonicalize unless this is 'battle-changed' or 'manual'. Use 'battle-changed' for Skill Swap, Worry Seed, etc.",
      ),
    teraType: z.string().optional(),
    dynamax: z.enum(['none', 'dynamax', 'gigantamax']).optional(),
  })
  .passthrough();

const PokemonBattleStateSchema = z
  .object({
    boosts: BoostTableSchema.optional(),
    status: z.enum(['none', 'burn', 'paralysis', 'sleep', 'freeze', 'poison', 'toxic']).optional(),
    alliesFainted: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Cumulative number of this Pokémon’s allies that have fainted so far; used by Last Respects and Supreme Overlord. This may exceed the number currently fainted if allies were revived.',
      ),
    timesHitByDirectDamage: z
      .number()
      .int()
      .min(0)
      .max(6)
      .optional()
      .describe(
        'Number of times this Pokémon has been hit by direct-damaging moves during the battle; used by Rage Fist.',
      ),
    abilityEffect: z.enum(['auto', 'active', 'inactive']).optional(),
    itemEffect: z.enum(['auto', 'active', 'inactive']).optional(),
    activeEffects: z.array(BattleEffectSchema).optional(),
    volatileConditions: z.array(BattleEffectSchema).optional(),
  })
  .passthrough();

export const BattlePokemonSchema = z
  .object({
    pokemon: ChampionPokemonStateSchema,
    state: PokemonBattleStateSchema.optional(),
  })
  .passthrough();

const SideStateSchema = z
  .object({
    sideConditions: z.array(BattleEffectSchema).optional(),
    alliesFainted: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Cumulative number of Pokémon that have fainted on this side; used for Last Respects and Supreme Overlord unless overridden by the Pokémon state.',
      ),
  })
  .passthrough();

const FieldStateSchema = z
  .object({
    weather: z.enum(['none', 'sun', 'rain', 'sand', 'snow']).optional(),
    terrain: z.enum(['none', 'electric', 'grassy', 'misty', 'psychic']).optional(),
    fieldConditions: z.array(BattleEffectSchema).optional(),
  })
  .passthrough();

export const BattleContextSchema = z
  .object({
    field: FieldStateSchema.optional(),
    attackerSide: SideStateSchema.optional(),
    defenderSide: SideStateSchema.optional(),
    format: z.enum(['singles', 'doubles']).optional(),
  })
  .passthrough();

const SPBudgetBaseSchema = z
  .object({
    maxTotalSP: z.number().int().min(0).max(66).optional().describe('Defaults to 66.'),
    reservedSP: z.number().int().min(0).max(66).optional().describe('Defaults to inferred known SP.'),
  })
  .passthrough();

const DamageThresholdSchema = z.object({
  mode: z.enum(['min', 'max', 'average']),
  value: z.number().min(0).describe('Damage ratio, e.g. 1.0 for 100% max HP.'),
});

const SpeedTargetSchema = z.union([
  z.object({
    speed: z.number().int().min(0).describe('Numeric final Speed benchmark.'),
    benchmarkLabel: z.string().optional(),
  }),
  z.object({
    battlePokemon: BattlePokemonSchema,
    benchmarkLabel: z.string().optional(),
  }),
]);

const SpeedTierFilterSchema = z.union([
  z.object({ type: z.literal('pokemon'), values: z.array(z.string()) }),
  z.object({
    type: z.literal('effect'),
    ids: z.array(z.string()),
    scope: z.enum(['pokemon', 'side', 'field']).optional(),
  }),
  z.object({ type: z.literal('item'), values: z.array(z.string()) }),
  z.object({ type: z.literal('ability'), values: z.array(z.string()) }),
  z.object({ type: z.literal('tag'), values: z.array(z.string()) }),
]);

export const GetMetaSnapshotRequestSchema = z
  .object({
    limit: z.number().int().positive().optional().describe('Default 20.'),
    includeBuilds: z.boolean().optional().describe('Default true.'),
    format: z.enum(['single', 'double', 'singles', 'doubles']).optional().describe('Default double.'),
  })
  .passthrough();

export const GetPokemonOptionsRequestSchema = z
  .object({
    pokemon: z
      .string()
      .min(1)
      .describe(
        "Pokémon name in any common spelling, e.g. 'Basculegion-F', 'basculegion-female', 'Floette'. Base-species names resolve to the meta forme when unambiguous; corrections are reported in inputCorrections/metaNotes.",
      ),
    includeTeammates: z.boolean().optional(),
    includeCounters: z.boolean().optional(),
    format: z.enum(['single', 'double', 'singles', 'doubles']).optional().describe('Default double.'),
  })
  .passthrough();

export const CalculateStatsRequestSchema = z
  .object({
    pokemon: BattlePokemonSchema,
    context: BattleContextSchema.optional(),
  })
  .describe('Calculate raw/stage-modified stats. For Mega/forme build requests, prefer get_pokemon_options first; unambiguous current-meta base-forme mistakes may be corrected server-side.')
  .passthrough();

export const CheckDamageMatchupRequestSchema = z
  .object({
    attacker: BattlePokemonSchema,
    defender: BattlePokemonSchema,
    move: z.string().min(1),
    context: BattleContextSchema.optional(),
  })
  .describe('Calculate damage for explicitly provided sets. Use get_pokemon_options first for current-format canonical formes; item choices are accepted as provided and not legality-validated.')
  .passthrough();

export const OptimizeOffensiveSpreadRequestSchema = z
  .object({
    attacker: BattlePokemonSchema,
    defender: BattlePokemonSchema,
    move: z.string().min(1),
    context: BattleContextSchema.optional(),
    offensiveStat: z.enum(['atk', 'spa']).optional(),
    targetDamageRatio: DamageThresholdSchema,
    allowedNatures: z.array(z.string()).optional(),
    spBudget: SPBudgetBaseSchema.extend({
      maxStatSP: z.number().int().min(0).max(32).optional().describe('Defaults to 32.'),
    }).optional(),
  })
  .passthrough();

export const OptimizeSurvivalSpreadRequestSchema = z
  .object({
    defender: BattlePokemonSchema,
    attacker: BattlePokemonSchema,
    move: z.string().min(1),
    context: BattleContextSchema.optional(),
    defensiveStat: z.enum(['def', 'spd']).optional(),
    survivalThreshold: z
      .object({
        maxDamageRatioLessThan: z.number().min(0).optional().describe('Defaults to 1.0.'),
      })
      .optional(),
    allowedNatures: z.array(z.string()).optional(),
    spBudget: SPBudgetBaseSchema.extend({
      maxHPSP: z.number().int().min(0).max(32).optional().describe('Defaults to 32.'),
      maxDefenseSP: z.number().int().min(0).max(32).optional().describe('Defaults to 32.'),
    }).optional(),
  })
  .passthrough();

export const OptimizeSpeedSpreadRequestSchema = z
  .object({
    self: BattlePokemonSchema,
    target: SpeedTargetSchema,
    context: BattleContextSchema.optional(),
    relation: z.enum(['outspeed', 'speedTie', 'underspeed']),
    allowedNatures: z.array(z.string()).optional(),
    spBudget: SPBudgetBaseSchema.extend({
      maxSpeedSP: z.number().int().min(0).max(32).optional().describe('Defaults to 32.'),
    }).optional(),
  })
  .passthrough();

export const GetSpeedTiersRequestSchema = z
  .object({
    limit: z.number().int().positive().optional().describe('Default 50.'),
    includeModifiers: z.boolean().optional().describe('Default true.'),
    filters: z.array(SpeedTierFilterSchema).optional(),
  })
  .passthrough();

const NumberRangeSchema = z.tuple([z.number(), z.number()]);
const ModifierBreakdownSchema = z.array(z.string());
const RuntimeStatTableSchema = z.object({
  hp: z.number().int(),
  atk: z.number().int(),
  def: z.number().int(),
  spa: z.number().int(),
  spd: z.number().int(),
  spe: z.number().int(),
});

const MetaSpreadSchema = z.object({
  nature: z.string(),
  sp: StatTableSchema,
  usage: z.number().optional(),
  label: z.string().optional(),
});

const UsageNameSchema = z.object({
  name: z.string(),
  usage: z.number().optional(),
});

const MetaPokemonSummarySchema = z.object({
  pokemon: z.string(),
  usage: z.number().optional(),
  rank: z.number().int().optional(),
  popularMoves: z.array(z.object({ move: z.string(), usage: z.number().optional() })).optional(),
  popularItems: z.array(z.object({ item: z.string(), usage: z.number().optional() })).optional(),
  popularAbilities: z.array(z.object({ ability: z.string(), usage: z.number().optional() })).optional(),
  popularSpreads: z.array(MetaSpreadSchema).optional(),
});

export const GetMetaSnapshotResponseSchema = z.object({
  format: z.literal('pokemon-champions'),
  generatedAt: z.string(),
  source: z.string().optional(),
  pokemon: z.array(MetaPokemonSummarySchema),
});

export const GetPokemonOptionsResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  pokemon: z.string(),
  moves: z.array(UsageNameSchema),
  items: z.array(UsageNameSchema),
  abilities: z.array(UsageNameSchema),
  spreads: z.array(MetaSpreadSchema),
  builds: z
    .array(
      z.object({
        label: z.string().optional(),
        pokemon: ChampionPokemonStateSchema,
        moves: z.array(z.string()).optional(),
        usage: z.number().optional(),
      }),
    )
    .optional(),
  teammates: z.array(UsageNameSchema).optional(),
  counters: z.array(UsageNameSchema).optional(),
  metaNotes: z.array(z.string()).optional(),
});

export const CalculateStatsResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  rawStats: RuntimeStatTableSchema,
  modifiedStats: RuntimeStatTableSchema.optional(),
  modifierBreakdown: ModifierBreakdownSchema,
});

export const CheckDamageMatchupResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  damageRange: NumberRangeSchema,
  damageRolls: z.array(z.number().int()),
  damageRollRatios: z.array(z.number()),
  koChance: z.number().min(0).max(1),
  modifierBreakdown: ModifierBreakdownSchema,
  description: z.string(),
});

export const OptimizeOffensiveSpreadResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  recommendedNature: z.string(),
  requiredSP: z.number().int().min(0).max(32),
  resultingDamageRange: NumberRangeSchema,
  koChance: z.number().min(0).max(1),
  modifierBreakdown: ModifierBreakdownSchema,
  isFeasibleUnderBudget: z.boolean(),
});

export const OptimizeSurvivalSpreadResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  recommendedNature: z.string(),
  recommendedSP: PartialStatTableSchema,
  totalSPUsed: z.number().int().min(0).max(66),
  resultingDamageRange: NumberRangeSchema,
  survives: z.boolean(),
  modifierBreakdown: ModifierBreakdownSchema,
  isFeasibleUnderBudget: z.boolean(),
});

export const OptimizeSpeedSpreadResponseSchema = z.object({
  inputCorrections: z.array(InputCorrectionSchema).optional(),
  recommendedNature: z.string(),
  requiredSpeedSP: z.number().int().min(0).max(32),
  resultingRawSpeed: z.number().int().min(0),
  resultingFinalSpeed: z.number().int().min(0),
  targetFinalSpeed: z.number().int().min(0),
  margin: z.number().int(),
  modifierBreakdown: ModifierBreakdownSchema,
  isFeasibleUnderBudget: z.boolean(),
});

export const GetSpeedTiersResponseSchema = z.object({
  generatedAt: z.string(),
  tiers: z.array(
    z.object({
      pokemon: BattlePokemonSchema,
      context: BattleContextSchema.optional(),
      rawSpeed: z.number().int().min(0),
      finalSpeed: z.number().int().min(0),
      description: z.string(),
      modifierBreakdown: ModifierBreakdownSchema,
      source: z.string().optional(),
    }),
  ),
});
