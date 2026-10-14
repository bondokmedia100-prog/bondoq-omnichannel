import { z } from "zod";

const optionalText = (max: number) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  z.string().trim().max(max).nullable().optional()
);

export const customerProfileSchema = z.object({
  displayName: optionalText(120),
  notes: optionalText(4000)
}).strict().refine((value) => value.displayName !== undefined || value.notes !== undefined);
