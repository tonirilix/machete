import { z } from 'zod'
import { draftSchema } from './library'

export const draftEditSchema = z
  .object({
    id: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
    action: z.enum(['update', 'save', 'discard']),
    draft: draftSchema.optional(),
  })
  .refine((value) => value.action === 'discard' || value.draft !== undefined, 'Draft is required.')

