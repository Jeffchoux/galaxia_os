<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	interface Props {
		form:
			| {
					error?: string;
					magic?: { sent?: boolean; message?: string; error?: string };
			  }
			| null;
	}
	let { form }: Props = $props();

	let emailInput: HTMLInputElement | undefined = $state();
	let pwInput: HTMLInputElement | undefined = $state();
	let showAdminForm = $state(false);

	onMount(() => emailInput?.focus());

	// Erreur arrivant par redirect depuis /auth/verify (lien magique expiré ou ré-utilisé).
	const verifyError = $derived.by(() => {
		const code = page.url.searchParams.get('error');
		if (code === 'missing-token') return 'Le lien de connexion est incomplet.';
		if (code === 'invalid-or-expired')
			return 'Ce lien de connexion est invalide ou expiré (validité 15 min, usage unique).';
		if (code === 'user-not-found')
			return "Cet utilisateur n'existe plus dans la galaxie.";
		return null;
	});

	function toggleAdmin() {
		showAdminForm = !showAdminForm;
		if (showAdminForm) {
			// Laisse le DOM peindre avant focus
			setTimeout(() => pwInput?.focus(), 0);
		}
	}
</script>

<svelte:head>
	<title>Galaxia — connexion</title>
</svelte:head>

<main class="wrap">
	<div class="card">
		<h1>Galaxia</h1>
		<p class="sub">Cockpit de la galaxie</p>

		{#if verifyError}
			<p class="error" role="alert">{verifyError}</p>
		{/if}

		{#if form?.magic?.sent}
			<div class="sent" role="status">
				<p>{form.magic.message}</p>
				<p class="hint">Le lien expire dans 15 minutes.</p>
			</div>
		{:else}
			<form method="POST" action="?/magicLink" class="primary">
				<label>
					<span>Votre adresse mail</span>
					<input
						type="email"
						name="email"
						autocomplete="email"
						placeholder="prenom@votre-pme.fr"
						bind:this={emailInput}
						required
					/>
				</label>
				{#if form?.magic?.error}
					<p class="error">{form.magic.error}</p>
				{/if}
				<button type="submit">Recevoir un lien de connexion</button>
				<p class="hint">
					Un lien temporaire vous sera envoyé par mail. Pas de mot de passe à retenir.
				</p>
			</form>

			<button
				type="button"
				class="toggle"
				aria-expanded={showAdminForm}
				onclick={toggleAdmin}
			>
				{showAdminForm ? '↑ Masquer' : '↓ Connexion administrateur'}
			</button>

			{#if showAdminForm}
				<form method="POST" action="?/password" class="secondary">
					<label>
						<span>Mot de passe administrateur</span>
						<input
							type="password"
							name="password"
							autocomplete="current-password"
							bind:this={pwInput}
							required
						/>
					</label>
					{#if form?.error}
						<p class="error">{form.error}</p>
					{/if}
					<button type="submit" class="admin">Entrer</button>
				</form>
			{/if}
		{/if}
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
		background: radial-gradient(circle at 30% 20%, #1a0e2e 0%, #05050a 60%);
		color: #e9e9f4;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			sans-serif;
		min-height: 100vh;
	}
	.wrap {
		display: grid;
		place-items: center;
		min-height: 100vh;
		padding: 1rem;
	}
	.card {
		width: 100%;
		max-width: 380px;
		background: rgba(20, 18, 32, 0.6);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(124, 58, 237, 0.25);
		border-radius: 16px;
		padding: 2rem;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
	}
	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.75rem;
		letter-spacing: -0.02em;
	}
	.sub {
		margin: 0 0 1.5rem;
		color: #8e8ea8;
		font-size: 0.9rem;
	}
	label {
		display: block;
		margin-bottom: 1rem;
	}
	label span {
		display: block;
		font-size: 0.85rem;
		color: #b9b9d0;
		margin-bottom: 0.4rem;
	}
	input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.7rem 0.9rem;
		background: rgba(10, 10, 20, 0.6);
		border: 1px solid rgba(124, 58, 237, 0.3);
		border-radius: 8px;
		color: #fff;
		font-size: 1rem;
		font-family: inherit;
	}
	input:focus {
		outline: none;
		border-color: #7c3aed;
	}
	button[type='submit'] {
		width: 100%;
		padding: 0.75rem;
		background: #7c3aed;
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}
	button[type='submit']:hover {
		background: #6d28d9;
	}
	button[type='submit'].admin {
		background: #3b3b55;
	}
	button[type='submit'].admin:hover {
		background: #4a4a6e;
	}
	.toggle {
		display: block;
		width: 100%;
		text-align: center;
		background: none;
		border: none;
		color: #8e8ea8;
		font-size: 0.8rem;
		margin-top: 1.25rem;
		padding: 0.5rem;
		cursor: pointer;
		font-family: inherit;
	}
	.toggle:hover {
		color: #b9b9d0;
	}
	.secondary {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid rgba(124, 58, 237, 0.15);
	}
	.error {
		color: #f87171;
		font-size: 0.875rem;
		margin: 0 0 1rem;
	}
	.hint {
		font-size: 0.8rem;
		color: #8e8ea8;
		margin: 0.75rem 0 0;
		line-height: 1.4;
	}
	.sent {
		background: rgba(52, 211, 153, 0.1);
		border: 1px solid rgba(52, 211, 153, 0.3);
		border-radius: 8px;
		padding: 1rem;
		color: #d1fae5;
	}
	.sent p {
		margin: 0 0 0.5rem;
	}
	.sent .hint {
		margin: 0;
		color: #94a3a8;
	}
</style>
