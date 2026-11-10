# Publier Cartograph

Ce guide t'accompagne de zéro jusqu'à une extension disponible dans le **Visual Studio Marketplace** (VS Code) et sur **Open VSX** (VSCodium, Cursor, Gitpod, Eclipse Theia…). Compte une heure la première fois.

## 0. Avant de commencer

Dans `package.json`, remplace les valeurs par défaut :

| Champ | À mettre |
|---|---|
| `publisher` | l'identifiant de **ton** éditeur (créé à l'étape 2). Aujourd'hui : `drichdev`. |
| `repository.url`, `bugs.url`, `homepage` | l'URL réelle de ton dépôt GitHub. Elle sert aussi à afficher les images du README sur la page du Marketplace. |
| `name` | `cartograph` : l'identifiant final sera `publisher.name` (ex. `drichdev.cartograph`). Il doit être unique ; si le nom est pris, change-le (et garde `displayName` tel quel). |
| `version` | commence à `0.1.0` ; `"preview": true` affiche l'étiquette *Preview* (retire-la pour la 1.0). |

Remplace aussi `drichdev/cartograph` dans `README.md`, `README.en.md`, `CONTRIBUTING.md` et les badges.

Vérifie la licence (`LICENSE`) et le nom d'auteur.

## 1. Préparer le dépôt GitHub

```bash
git init
git add .
git commit -m "Cartograph 0.1.0"
git branch -M main
git remote add origin https://github.com/<ton-compte>/cartograph.git
git push -u origin main
```

## 2. Créer ton éditeur (publisher) sur le Marketplace

1. Va sur <https://marketplace.visualstudio.com/manage> et connecte-toi avec un compte Microsoft (il sera relié à une organisation Azure DevOps ; la création est gratuite).
2. Clique sur **Create publisher** : choisis un **ID** (minuscules, sans espaces : c'est celui du champ `publisher`) et un nom affiché.

## 3. Créer un jeton d'accès (PAT)

1. Va sur <https://dev.azure.com> → ton organisation → **User settings** (icône en haut à droite) → **Personal access tokens** → **New Token**.
2. *Organization* : **All accessible organizations**. *Expiration* : 90 jours à 1 an.
3. *Scopes* : **Custom defined** → **Show all scopes** → coche **Marketplace → Manage**.
4. Copie le jeton (il ne sera plus affiché). Ne le mets **jamais** dans le dépôt.

## 4. Construire et tester le paquet

```bash
npm ci
npm run typecheck
npm test               # test de fumée (après npm run build)
npm run package        # produit cartograph-0.1.0.vsix
```

Installe-le localement pour l'essayer comme un utilisateur :

```bash
code --install-extension cartograph-0.1.0.vsix
```

Checklist à faire à la main dans une fenêtre VS Code **propre** :

- [ ] La commande *Cartograph : Ouvrir la carte du projet* s'affiche et ouvre la carte.
- [ ] Un projet Python, un projet TypeScript et un projet mixte s'analysent.
- [ ] Le sélecteur FR / EN change la langue sans recharger.
- [ ] Le bouton Exporter produit un PNG, un SVG et un fichier Mermaid.
- [ ] *Évolution* : enregistrer l'état, modifier un fichier, voir la différence ; *Comparer avec Git…* fonctionne dans un dépôt.
- [ ] Un dossier sans code affiche le message « Aucun code trouvé » (pas d'erreur).
- [ ] Aucun message d'erreur dans **Sortie → Cartograph**.
- [ ] Thème clair et thème sombre lisibles.
- [ ] Sous Windows : Python est trouvé (`python` ou `py`).

Ajoute 2 à 4 **captures d'écran** dans `media/screenshots/` (vue Système, vue Architecture, vue Évolution) et affiche-les dans le README : c'est ce qui convainc d'installer. Garde les images à moins de 1 Mo chacune.

## 5. Publier sur le Marketplace

```bash
npx vsce login <ton-publisher>      # colle le PAT quand il le demande
npm run publish:vsce                # compile en production puis publie
```

Variantes utiles :

```bash
npx vsce publish minor              # 0.1.0 → 0.2.0 (ou patch / major)
npx vsce publish --pre-release      # version préliminaire
npx vsce ls                         # liste exactement les fichiers qui seront publiés
```

Après quelques minutes (la vérification antivirus peut prendre jusqu'à ~15 min), la page est en ligne :
`https://marketplace.visualstudio.com/items?itemName=<publisher>.cartograph`.

## 6. Publier sur Open VSX (VSCodium, Cursor, Gitpod…)

Le Marketplace de Microsoft n'est pas accessible aux forks de VS Code : ils utilisent Open VSX.

1. Crée un compte sur <https://open-vsx.org> (connexion GitHub) et signe l'accord de publication (*Eclipse Publisher Agreement*) depuis ton profil.
2. Génère un jeton : <https://open-vsx.org/user-settings/tokens>.
3. Crée ton espace de noms (une seule fois) puis publie :

```bash
npx ovsx create-namespace <ton-publisher> -p <jeton-ovsx>
OVSX_PAT=<jeton-ovsx> npm run publish:ovsx
```

## 7. Automatiser avec GitHub Actions

Le dépôt contient deux workflows :

- `.github/workflows/ci.yml` : à chaque *push* et *pull request*, compile, vérifie les types, lance `npm test` sous Linux, Windows et macOS, et garde le `.vsix` en artefact.
- `.github/workflows/release.yml` : quand tu pousses un tag `v*` (ex. `v0.1.1`), compile, publie sur le Marketplace **et** Open VSX, et attache le `.vsix` à une *release* GitHub.

Configure les **secrets** du dépôt (*Settings → Secrets and variables → Actions*) :

| Secret | Valeur |
|---|---|
| `VSCE_PAT` | le jeton Azure DevOps de l'étape 3 |
| `OVSX_PAT` | le jeton Open VSX de l'étape 6 |

## 8. Publier une nouvelle version

1. Mets à jour `CHANGELOG.md`.
2. `npm version patch` (ou `minor` / `major`) : met à jour `package.json`, crée le commit et le tag.
3. `git push --follow-tags` → le workflow `release.yml` publie tout seul.

Règles de versionnage ([SemVer](https://semver.org/lang/fr/)) : **patch** pour les corrections, **minor** pour les nouveautés compatibles (nouveau langage, nouvelle vue), **major** si un réglage ou un comportement change de façon incompatible.

## Erreurs fréquentes

| Message | Cause et solution |
|---|---|
| `Make sure to edit the README.md file before you publish` | Le README est celui du modèle : le nôtre est déjà complet. |
| `Couldn't detect the repository where this extension is published` | Renseigne `repository` dans `package.json` (les images relatives du README en ont besoin). |
| `The Personal Access Token verification has failed` | Jeton expiré, ou *Organization* ≠ *All accessible organizations*, ou scope *Marketplace → Manage* manquant. |
| `Extension ID ... already exists` / publisher inconnu | Le champ `publisher` doit être **exactement** l'ID créé à l'étape 2. |
| `icon ... must be a PNG` | L'icône doit être un PNG (`media/icon.png`, ≥ 128×128), pas un SVG. |
| `SVGs are not valid icons` / images SVG dans le README | Seules les images servies en HTTPS depuis des sources de confiance sont acceptées ; utilise des PNG. |
| Paquet trop gros | `npx vsce ls` pour voir ce qui est inclus ; complète `.vscodeignore` (les grammaires `.wasm` et `analyze_ts.js` pèsent ~5 Mo : c'est normal). |
| Les analyseurs échouent après installation | Un fichier de `dist/` ou `analyzer/` est exclu par erreur : vérifie `npx vsce ls`. |

## Retirer ou mettre à jour une publication

- Masquer l'extension : <https://marketplace.visualstudio.com/manage> → ton éditeur → *… → Unpublish*.
- Retirer une version précise : `npx vsce unpublish <publisher>.cartograph` retire **toute** l'extension (à éviter) ; préfère publier une version corrigée.

## Après la publication

- Ajoute le badge d'installations dans le README (déjà prévu avec shields.io).
- Active les *Discussions* GitHub pour les questions ; les issues pour les bugs (modèles fournis dans `.github/ISSUE_TEMPLATE/`).
- Surveille les avis et les statistiques sur la page de gestion de l'éditeur.
