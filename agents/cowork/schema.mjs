// Schémas Zod pour l'orchestrateur Cowork.
// Importé par orchestrator.mjs pour valider le bloc <plan>...</plan> que le
// planner (Claude Agent SDK) émet à la fin de la phase PLAN.
//
// Le contrat partagé gèle ce schéma : ne pas en dévier (les statuts/risques et la
// règle d'acyclicité du DAG sont les mêmes côté DB et côté API).

import { z } from 'zod';

export const CoworkRiskSchema = z.enum(['safe', 'mutating', 'consequential']);

export const CoworkSubtaskPlanSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10),
  risk: CoworkRiskSchema,
  depends_on: z.array(z.number().int().nonnegative()).default([])
});

// Le planner renvoie une LISTE ORDONNÉE de sous-tâches. depends_on référence
// l'index (0-based) d'une sous-tâche ANTÉRIEURE dans la liste → DAG acyclique
// par construction (on rejette toute dépendance >= à l'index courant).
export const CoworkPlanSchema = z
  .object({
    subtasks: z.array(CoworkSubtaskPlanSchema).min(1).max(20),
    notes: z.string().optional()
  })
  .superRefine((plan, ctx) => {
    plan.subtasks.forEach((st, i) => {
      for (const dep of st.depends_on) {
        if (dep >= i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `subtask ${i} depends_on ${dep} which is not a prior subtask (cycle/forward ref)`,
            path: ['subtasks', i, 'depends_on']
          });
        }
      }
    });
  });
