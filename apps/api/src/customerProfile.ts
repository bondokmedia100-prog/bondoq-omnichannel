import { z } from "zod";

const optionalText = (max: number) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  z.string().trim().max(max).nullable().optional()
);

export const customerProfileSchema = z.object({
  displayName: optionalText(120),
  notes: optionalText(4000),
  phone: z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().max(32).nullable().optional()),
  email: z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().email().max(254).nullable().optional())
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined));
