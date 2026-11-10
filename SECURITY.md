# Sécurité et confidentialité

## Ce que fait (et ne fait pas) Cartograph

- L'analyse est **entièrement locale** : elle s'exécute dans des processus enfants lancés par l'extension, sur ta machine.
- L'extension ne fait **aucune requête réseau** et n'envoie **aucune télémétrie**.
- Les caches (`*.cache`, `*.json`) sont écrits dans le dossier de stockage global de l'extension, jamais dans ton projet.
- La comparaison Git crée un `git worktree` temporaire dans le dossier temporaire du système et le supprime ensuite.

## Bases de données

- Les bases ne sont lues que si tu les déclares dans `cartograph.databases` (SQLite du projet : lecture automatique, fichier ouvert en `mode=ro`).
- Les connexions PostgreSQL/MongoDB sont **en lecture seule** (`readonly`, requêtes de métadonnées et échantillon de documents).
- Les URI sont transmises à l'analyseur par **variable d'environnement**, jamais sur la ligne de commande, et les identifiants sont masqués dans l'interface. Utilise `${env:NOM}` plutôt qu'un mot de passe en clair dans les réglages.

## Webview

L'interface applique une politique de sécurité de contenu stricte (`default-src 'none'`, scripts avec nonce, aucune ressource distante).

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique. Écris à l'adresse indiquée dans le profil du dépôt GitHub (ou utilise « Report a vulnerability » dans l'onglet *Security* du dépôt). Tu recevras une réponse sous 7 jours.

## Versions prises en charge

Seule la dernière version publiée reçoit des correctifs de sécurité.
