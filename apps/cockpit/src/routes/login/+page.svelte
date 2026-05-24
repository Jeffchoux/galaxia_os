<script lang="ts">
	import { onMount } from 'svelte';
	interface Props {
		form: { error?: string } | null;
	}
	let { form }: Props = $props();
	let pwInput: HTMLInputElement | undefined = $state();
	onMount(() => pwInput?.focus());
</script>

<svelte:head>
	<title>Galaxia — connexion</title>
</svelte:head>

<main class="wrap">
	<div class="card">
		<h1>Galaxia</h1>
		<p class="sub">Cockpit de la galaxie mère</p>
		<form method="POST">
			<label>
				<span>Mot de passe</span>
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
			<button type="submit">Entrer</button>
		</form>
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
		max-width: 360px;
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
	button {
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
	button:hover {
		background: #6d28d9;
	}
	.error {
		color: #f87171;
		font-size: 0.875rem;
		margin: 0 0 1rem;
	}
</style>
