# Ajouter un langage de code

Les langages analysés avec tree-sitter (Go, Java, Kotlin, PHP, Rust) partagent un **moteur commun** (`src/sitter/index.ts`) ; chaque langage n'a besoin que d'un **extracteur** qui transforme un fichier en `FileInfo`. Le moteur se charge de la résolution des appels, de l'infrastructure, des modèles, des routes et de la sortie JSON.

## 1. Choisir la grammaire

- Cherche `tree-sitter-<langage>.wasm` dans `node_modules/tree-sitter-wasms/out/`.
- Si elle n'existe pas (c'est le cas de Dart), deux options : compiler la grammaire en WebAssembly (outillage emscripten) ou écrire un analyseur lexical léger comme `src/sitter/dart.ts`.

> Version de runtime : `web-tree-sitter@0.20.8` charge les grammaires d'ABI 13 et 14. Garde cette version tant que `tree-sitter-wasms` n'est pas mis à jour en bloc.

## 2. Écrire l'extracteur

Crée `src/sitter/<langage>.ts` exportant `extract<Langage>(root, rel, src): FileInfo` (voir `go.ts` pour le plus simple, `java.ts` pour un langage à classes). Un extracteur doit remplir :

| Champ de `FileInfo` | Contenu |
|---|---|
| `imports`, `importPaths` | alias → chemin d'import (sert à reconnaître l'infrastructure et à résoudre les appels) |
| `defs` | une entrée par fonction/méthode : `qual` (`Classe.methode`), `calls`, `refs`, `complexity`, `toks` (types de nœuds, pour les doublons), `route`, `worker`, `entry`, `http`, `annotations` |
| `types` | classes/structs/interfaces : `fields` (nom → type), `bases` (héritage, interfaces, traits), `annotations` |
| `issues` | problèmes de sécurité trouvés (`rule` + `params`, voir `messages.ts`) |
| `routeRefs`, `workerRefs` | handlers référencés par nom (`app.get("/x", handler)`) |
| `binds` | liaisons d'injection explicites (`interface` → `implémentation`) |

Un appel (`Call`) décrit **comment il est écrit**, pas où il va : `name`, `plain` (sans qualification), `pkg` (alias de paquet), `root` (type de la variable racine) et `chain` (champs traversés). Le moteur retrouve la cible.

## 3. Brancher le langage

Dans `src/sitter/index.ts` :

1. Ajoute l'extension dans `EXT` et dans `stripExt`.
2. Ajoute l'appel à ton extracteur dans la boucle d'extraction.
3. Ajoute les chemins d'import d'infrastructure dans `INFRA_PATHS` (préfixes de paquets : `redis`, `gorm.io/gorm`…).
4. Si le langage a un modèle de données reconnaissable (entités, structs sérialisables), ajoute une règle dans `classify()`.

Dans `src/ts-analyzer/config.ts` : ajoute les noms de dossiers caractéristiques à `TOKEN_LAYER` (couches) si besoin.

Dans `esbuild.mjs` : ajoute la grammaire à `copyGrammars()` ; dans `src/extension.ts` : ajoute le `languageId` à la liste des langages qui relancent l'analyse à l'enregistrement.

## 4. Tester

1. Ajoute un petit service dans `sample_project/<langage>-service/` avec : une route, un appel via une couche (service → dépôt), un client d'infrastructure, une fonction inutilisée, une faille.
2. Lance `node dist/analyze_multi.js sample_project/<langage>-service --out /tmp/out.json` et lis le JSON : nœuds, arêtes, `infra`, `issues`.
3. Ajoute la vérification correspondante à `scripts/smoke-test.mjs`.

## Conseils

- Commence par les **fonctions et les appels**, puis l'infrastructure, puis les routes : chaque étape donne déjà une carte utile.
- Sur les arbres tree-sitter, imprime la structure d'un petit fichier (`node.type`, `namedChildren`) avant d'écrire les accès : les noms de nœuds varient beaucoup d'une grammaire à l'autre.
- Reste approximatif mais honnête : un lien incertain vaut mieux qu'un lien faux ; le moteur marque les liens déduits d'un simple nom comme « incertains ».
