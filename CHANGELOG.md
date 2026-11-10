# Changelog

Toutes les évolutions notables de Cartograph. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versionnage [SemVer](https://semver.org/lang/fr/).

## [0.1.0] — première version publique

### Ajouté
- **Six vues** : Système, Architecture, Appels, Données, Évolution, Qualité.
- **Langages** : Python (AST), TypeScript/JavaScript (compilateur TypeScript), Go, Java, Kotlin, PHP et Rust (tree-sitter), Dart/Flutter (analyseur lexical léger).
- **Frameworks reconnus** : FastAPI, Flask, Celery, Next.js, Express, NestJS, React, BullMQ, Prisma, Mongoose, TypeORM, gin/echo/chi, gorm, Spring, JPA, Ktor, Laravel, Symfony, Eloquent, axum, actix, sqlx, GoRouter, Dio…
- **Infrastructure** : Redis, MongoDB, SQL, files de tâches, brokers, stockage objet, LLM, services de `docker-compose.yml` et `Procfile`.
- **Liens HTTP front → back** : un `fetch("/users/…")` est relié à la route correspondante, quel que soit le langage.
- **Injection de dépendances** : FastAPI `Depends`/`Annotated`, NestJS, Spring `@Bean`, Go `wire`, interfaces et traits.
- **Schéma réel des bases** : SQLite automatique ; PostgreSQL et MongoDB en lecture seule sur demande.
- **Évolution** : état de référence et comparaison avec une révision Git (`git worktree` temporaire).
- **Détections** : code mort, doublons, complexité, failles de sécurité, imports circulaires, dépendances remontantes.
- **Export** PNG, SVG et Mermaid.
- **Interface en français et en anglais** (réglage `cartograph.language`).
- **Performances** : serveur TypeScript persistant, caches par fichier (Python et multi-langages).
- **Fiabilité** : le cache Python se régénère seul s'il est invalide ; un fichier qui pose problème est ignoré au lieu de faire échouer toute l'analyse ; la vraie erreur est affichée et journalisée (Sortie → Cartograph).
