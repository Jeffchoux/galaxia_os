// Routeur de tâches souverain — incrément 1 : coder/chat.
//
// Pour le mode "auto", décide quel moteur traite le tour :
//   - 'free' (Groq gratuit, LECTURE seule) : converser, expliquer, lire le repo.
//   - 'pro'  (Opus 4.8, peut écrire/coder + vision) : tâches techniques
//     d'écriture, et pièces jointes (le mode rapide ne voit pas les fichiers).
//
// 100 % LOCAL et DÉTERMINISTE : aucune dépendance réseau, aucun coût, aucune
// donnée envoyée hors du serveur. Donc (1) empaquetable tel quel dans les
// galaxies filles, (2) conforme à la règle "pas de modèle premium par défaut" —
// le défaut est 'free', on n'escalade vers Opus (payant) que sur un signal clair,
// et la raison est renvoyée au client pour rester transparent sur le coût.
//
// Aligné sur la politique de Jeff : Opus réservé à "coder / améliorer Galaxia
// + ma com". On escalade donc sur les verbes d'écriture de code ET de rédaction.

export type Engine = 'free' | 'pro';

export interface RouteDecision {
	engine: Engine;
	reason: string;
}

// Verbes / signaux qui impliquent une ÉCRITURE (code ou contenu) ou une tâche
// technique lourde → Opus. On reste volontairement sur l'intention d'action :
// "explique le code de X" ou "c'est quoi ce fichier" restent en gratuit (lecture).
const ESCALATE_RE = new RegExp(
	[
		// — écriture / modification de code
		'impl[ée]mente', 'impl[ée]menter',
		'cod(?:e|er|e-?moi|ez)\\b',
		'[ée]cris(?:-?moi)? (?:le |un |du )?code', '[ée]crire (?:le |du )?code',
		'modifie', 'modifier', '[ée]dite', '[ée]diter',
		'refactor\\w*', 'r[ée][ée]cris', 'r[ée][ée]crire',
		'corrige', 'corriger', 'd[ée]bog\\w*', 'debug',
		'cr[ée]e?(?:r)? (?:un|le|une) (?:fichier|fonction|route|m[ée]thode|endpoint|composant|test|script|migration)',
		'ajoute (?:une|la|le|un|des) (?:fonction|route|m[ée]thode|endpoint|composant|test|colonne|champ)',
		'supprime (?:la|le|du|les) (?:fonction|route|ligne|fichier|code)',
		'patch\\w*', 'g[ée]n[èe]re (?:le|un) (?:code|script)',
		// — git / déploiement
		'commit\\w*', 'pousse sur', '\\bpush\\b', 'fais (?:une|la) pr', 'ouvre une pr', 'd[ée]ploie', 'd[ée]ployer',
		// — rédaction de contenu / com (Opus aussi, par choix de Jeff)
		'r[ée]dige', 'r[ée]diger', '[ée]cris(?:-?moi)? (?:un|une|le|la) (?:post|article|mail|e-?mail|tweet|newsletter|texte|page|script|legende|l[ée]gende)'
	].join('|'),
	'i'
);

// Bloc de code collé (``` ) — ambigu (peut être "explique ce code"), donc PAS
// un signal d'escalade à lui seul : on ne route sur Opus que si un verbe d'action
// l'accompagne (déjà couvert par ESCALATE_RE sur le texte autour).

export function routeChat(message: string, hasDocs: boolean): RouteDecision {
	if (hasDocs) {
		return {
			engine: 'pro',
			reason: 'pièce jointe à analyser — le mode rapide ne voit pas les fichiers/images'
		};
	}
	const text = message ?? '';
	if (ESCALATE_RE.test(text)) {
		return { engine: 'pro', reason: 'tâche technique / rédaction détectée' };
	}
	return { engine: 'free', reason: 'conversation ou lecture — moteur gratuit suffisant' };
}
