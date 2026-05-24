// Tarifs Anthropic par modèle, en micro-USD par token (= USD par million tokens).
// Source : https://docs.anthropic.com/en/docs/about-claude/pricing — à re-vérifier
// périodiquement, les prix changent (notamment quand un nouveau modèle sort).
//
// On stocke en micro-USD pour rester sur des entiers (évite les drifts float
// quand on cumule des milliers d'appels). 1 USD = 1_000_000 micros.
//
// Cache pricing (Anthropic) :
//   cache_creation_input_tokens : facturé à 1.25× le tarif input
//   cache_read_input_tokens     : facturé à 0.10× le tarif input
// On les comptabilise séparément pour avoir une facture juste.

interface ModelPricing {
	input: number; // micro-USD / token
	output: number;
	cache_create_multiplier: number;
	cache_read_multiplier: number;
}

const DEFAULT_PRICING: ModelPricing = {
	// Fallback prudent si on rencontre un modèle inconnu : on prend la grille
	// Sonnet (le milieu de gamme). Mieux vaut sur-estimer que zéro.
	input: 3,
	output: 15,
	cache_create_multiplier: 1.25,
	cache_read_multiplier: 0.1
};

// Tarifs au 2026-05-24 (à raffraîchir si Anthropic publie des changements).
const PRICING: Record<string, ModelPricing> = {
	'claude-opus-4-7': {
		input: 15,
		output: 75,
		cache_create_multiplier: 1.25,
		cache_read_multiplier: 0.1
	},
	'claude-sonnet-4-6': {
		input: 3,
		output: 15,
		cache_create_multiplier: 1.25,
		cache_read_multiplier: 0.1
	},
	'claude-haiku-4-5-20251001': {
		input: 0.8,
		output: 4,
		cache_create_multiplier: 1.25,
		cache_read_multiplier: 0.1
	}
};

// Compat avec le type Usage du SDK Anthropic : les champs cache_* sont
// `number | null` (pas `number | undefined`). On accepte les deux.
export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}

// Retourne le coût en micro-USD (entier arrondi). Utilise la grille tarifaire
// du modèle si connu, sinon le DEFAULT_PRICING.
export function computeCostMicros(model: string, u: TokenUsage): number {
	const p = PRICING[model] ?? DEFAULT_PRICING;
	const cacheCreate = u.cache_creation_input_tokens ?? 0;
	const cacheRead = u.cache_read_input_tokens ?? 0;
	const total =
		u.input_tokens * p.input +
		u.output_tokens * p.output +
		cacheCreate * p.input * p.cache_create_multiplier +
		cacheRead * p.input * p.cache_read_multiplier;
	return Math.round(total);
}
