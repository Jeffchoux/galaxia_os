import { marked, Renderer, type Tokens } from 'marked';

// Rendu markdown → HTML *sûr à injecter via {@html}* dans l'origine du cockpit,
// sans dépendance de sanitisation (DOMPurify/jsdom = trop lourd pour le packaging
// offline des galaxies filles).
//
// Stratégie : on ne *nettoie pas* du HTML déjà produit (fragile), on *empêche* à
// la source les deux seuls vecteurs dangereux du markdown :
//   1. HTML brut embarqué dans la source (`<script>`, `<img onerror>`, `<div onclick>`…)
//      → supprimé entièrement (le texte entre balises survit, échappé par marked).
//   2. URLs à schéma exécutable dans les liens/images (`javascript:`, `data:` non-image…)
//      → liens neutralisés (gardent leur texte), images supprimées.
// Tout le reste de la sortie de marked n'est que du balisage structurel inerte
// (h1-6, p, a, ul/ol/li, code, pre, blockquote, table, em/strong, hr, br, img).

// Schémas autorisés pour un href de lien.
function isSafeLinkHref(href: string): boolean {
	const h = href.trim();
	if (/^(https?:|mailto:|tel:|#)/i.test(h)) return true;
	if (/^\/(?!\/)/.test(h)) return true; // chemin absolu local, mais pas `//host` (protocol-relative)
	if (/^\.{1,2}\//.test(h)) return true; // relatif `./` ou `../`
	return false; // bloque javascript:, data:, vbscript:, file:, etc.
}

// Schémas autorisés pour un src d'image. data: limité aux images bitmap
// (pas de SVG : un SVG peut embarquer du script).
function isSafeImgSrc(src: string): boolean {
	const s = src.trim();
	if (/^https?:\/\//i.test(s)) return true;
	if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return true;
	if (/^\/(?!\/)/.test(s)) return true;
	if (/^\.{1,2}\//.test(s)) return true;
	return false;
}

export function renderMarkdownSafe(src: string): string {
	const renderer = new Renderer();

	// 1. Supprime tout HTML brut (bloc + inline).
	renderer.html = () => '';

	// 2a. Liens : href non sûr → on ne garde que le texte visible (inerte).
	const renderLink = renderer.link.bind(renderer);
	renderer.link = (token: Tokens.Link) => {
		if (!isSafeLinkHref(token.href)) return token.text ?? '';
		return renderLink(token);
	};

	// 2b. Images : src non sûr → image supprimée.
	const renderImage = renderer.image.bind(renderer);
	renderer.image = (token: Tokens.Image) => {
		if (!isSafeImgSrc(token.href)) return '';
		return renderImage(token);
	};

	return marked.parse(src, { gfm: true, breaks: true, async: false, renderer }) as string;
}
