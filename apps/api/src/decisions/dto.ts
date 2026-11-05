import { z } from 'zod';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');

export const votingRuleSchema = z.enum(['majority', 'two_thirds', 'unanimous']);

export const governanceSchema = z.object({
  quorumPercent: z.number().int().min(0).max(100).optional(),
  votingRule: votingRuleSchema.optional(),
  allowAbstain: z.boolean().optional(),
  defaultDurationHours: z.number().int().min(1).max(24 * 30).optional(),
  autoClosePolls: z.boolean().optional(),
});

export const pollSchema = z
  .object({
    kind: z.enum(['simple', 'date']).default('simple'),
    question: z.string().trim().min(1).max(300),
    description: z.string().max(4000).default(''),
    options: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(40).optional(),
          label: z.string().trim().min(1).max(200),
        }),
      )
      .min(2)
      .max(20),
    multiChoice: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    quorumPercent: z.number().int().min(0).max(100).optional(),
    votingRule: votingRuleSchema.optional(),
    closesAt: isoDate.optional(),
  })
  .refine((value) => value.multiChoice || value.options.length >= 2, {
    message: 'poll_options_required',
    path: ['options'],
  });

export const pollVoteSchema = z.object({
  optionKeys: z.array(z.string().trim().min(1)).min(1).max(20),
  comment: z.string().trim().max(1000).default(''),
});

export const pollCloseSchema = z.object({
  reason: z.string().trim().max(500).default(''),
});

export const proposalSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(20000).default(''),
  votingRule: votingRuleSchema.optional(),
  quorumPercent: z.number().int().min(0).max(100).optional(),
  closesAt: isoDate.optional(),
});

export const proposalUpdateSchema = proposalSchema.partial();

export const proposalVoteSchema = z.object({
  choice: z.enum(['yes', 'no', 'abstain']),
  comment: z.string().trim().max(1000).default(''),
});

export const proposalTransitionSchema = z.object({
  status: z.enum(['discussion', 'voting', 'withdrawn']),
});

export const wishlistSchema = z.object({
  title: z.string().trim().min(1).max(200),
  ownerUserId: z.string().min(1).nullable().default(null),
  visibility: z.enum(['household', 'network']).default('household'),
  occasion: z.string().trim().max(120).default(''),
  dueAt: isoDate.nullable().optional(),
});

export const wishlistUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  ownerUserId: z.string().min(1).nullable().optional(),
  visibility: z.enum(['household', 'network']).optional(),
  occasion: z.string().trim().max(120).optional(),
  dueAt: isoDate.nullable().optional(),
});

export const wishlistItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().max(2000).default(''),
  priceCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  currency: z.string().trim().length(3).default('EUR'),
  notes: z.string().max(2000).default(''),
  priority: z.number().int().min(1).max(3).default(2),
});

export const wishlistItemPatchSchema = wishlistItemSchema.partial().extend({
  reserved: z.boolean().optional(),
  purchased: z.boolean().optional(),
});

export const decisionHistoryQuerySchema = z.object({
  entity: z.enum(['poll', 'proposal', 'governance']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
