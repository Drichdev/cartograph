# Contribuer à Cartograph

Merci de l'intérêt ! Ce document explique comment travailler sur le code.

## Prérequis

- Node.js ≥ 18, VS Code ≥ 1.85
- Python ≥ 3.9 (pour l'analyseur Python et les tests)
- Git

## Démarrer

```bash
git clone https://github.com/drichdev/cartograph.git
cd cartograph
npm install
npm run build        # compile l'extension, l'interface et les analyseurs dans dist/
code .
```

Appuie sur **F5** : une fenêtre « Extension Development Host » s'ouvre sur `sample_project/`, un projet de démonstration multi-langages (FastAPI + Celery, Next.js + Prisma + BullMQ, NestJS, Go, Java, Kotlin, PHP, Flutter, Rust).

`npm run watch` recompile à chaque modification.

## Organisation du code

```
src/extension.ts        Panneau, lancement des analyseurs, état de référence, comparaison Git, export
src/ts-server.ts        Processus TypeScript persistant
src/merge.ts            Fusion des graphes, liens HTTP front -> back
src/ts-analyzer/        Analyseur TypeScript/JavaScript + sortie JSON commune (output.ts)
src/sitter/             Analyseur multi-langages : moteur (index.ts) + un extracteur par langage
analyzer/analyze.py     Analyseur Python (bibliothèque standard uniquement)
analyzer/dbschema.py    Lecture en lecture seule du schéma réel des bases
webview/                Interface React + React Flow ; messages.ts = dictionnaire FR/EN
scripts/                smoke-test.mjs, make-assets.mjs
sample_project/         Projet de démonstration (sert aussi aux tests)
```

Tous les analyseurs produisent **le même JSON** (nœuds, arêtes, modules, modèles, infra, problèmes…) : c'est le contrat entre l'analyse et l'interface. La référence est la fin de `analyzer/analyze.py` (`run()`) et `src/ts-analyzer/output.ts` (`finalize()`).

## Vérifier avant de proposer une modification

```bash
npm run typecheck    # TypeScript (extension + interface)
npm run build
npm test             # test de fumée : trois analyseurs sur sample_project
```

Les tests de fumée vérifient notamment que chaque langage trouve ses routes, que les caches fonctionnent et que l'infrastructure est détectée. Ajoute un cas à `sample_project/` quand tu ajoutes une détection.

## Ajouter une langue d'interface

1. Dans `webview/messages.ts`, chaque entrée est `"clé": [français, anglais]` : ajoute une colonne (et adapte `makeT` dans `webview/i18n.ts`).
2. Ajoute `package.nls.<code>.json` pour le manifeste (commandes, réglages).
3. Ajoute le code de langue dans le sélecteur de `App.tsx` et dans `currentLang()` (`src/extension.ts`).

Les messages produits par les analyseurs sont traduits par règle : ils émettent un `rule` et des `params`, le texte vit dans `messages.ts` (`issue.<règle>`).

## Ajouter un langage de code

Voir [`docs/ADD_A_LANGUAGE.md`](docs/ADD_A_LANGUAGE.md).

## Style

- TypeScript strict, pas de dépendance d'exécution : tout est embarqué par esbuild.
- Python : bibliothèque standard uniquement, compatible 3.9.
- Un message visible par l'utilisateur passe toujours par `messages.ts` (interface) ou `package.nls*.json` (manifeste).

## Proposer une modification

1. Crée une branche, fais des commits courts et clairs.
2. Mets à jour `CHANGELOG.md` (section « Non publié »).
3. Ouvre une pull request en décrivant le problème résolu et comment tu l'as vérifié.
