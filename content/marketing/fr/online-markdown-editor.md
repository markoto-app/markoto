---
title: Éditeur Markdown en ligne avec aperçu paginé
description: Écrivez du Markdown dans votre navigateur et voyez-le en pages au fil de la frappe. Sans inscription. Partage, édition à plusieurs, export .md ou PDF.
keywords:
  - éditeur markdown en ligne
  - éditeur markdown en ligne gratuit
  - éditeur markdown avec aperçu
  - aperçu markdown en direct
  - markdown en ligne
# Menu label once reviewed (group + order come from the English page).
navLabel: "Éditeur Markdown en ligne"
updated: '2026-11-25'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Un éditeur Markdown en ligne avec aperçu paginé

Vous tapez du Markdown, et l'aperçu à côté affiche le texte en pages, telles qu'elles seront imprimées. L'éditeur fonctionne dans votre navigateur et ne demande aucun compte. Essayez ici :

::try-it{theme="modern"}
---
source: |
  # Compte rendu de réunion

  **Date :** 4 novembre · **Avec :** Maya, Sam

  ## Décisions

  1. La bêta sort ==lundi==.
  2. L'ancien export reste encore une version.

  ## Actions

  - [ ] Maya : rédiger les notes de version
  - [ ] Sam : vérifier le PDF au format Letter
  - [x] Réserver la salle

  | Sujet   | Responsable | Échéance |
  |:--------|:------------|:---------|
  | Bêta    | Maya        | lun.     |
  | Tarifs  | Sam         | ven.     |
---
::

Pour garder le texte, **Ouvrir comme document** en fait un vrai document avec son propre lien. L'éditeur complet ajoute une barre de mise en forme, des menus, des thèmes, des commentaires et un historique.

## Ce que vous pouvez faire sans compte

Sur markoto.app, vous pouvez commencer à écrire tout de suite. Sans compte, vous pouvez :

- créer des documents et les modifier avec l'éditeur complet ;
- partager le lien : toute personne qui l'a peut lire et modifier, en direct ;
- importer des fichiers et télécharger le Markdown ou un PDF.

Un document créé sans compte est supprimé après 30 jours sans modification. La première fois, markoto vous demande d'accepter les conditions d'utilisation et effectue une courte vérification anti-robots dans votre navigateur.

Un compte gratuit ajoute des documents qui vous appartiennent et restent privés tant que vous ne les partagez pas, des liens en lecture seule ou protégés par mot de passe, des espaces de travail pour une équipe, l'import d'images et l'assistant IA. La [page des tarifs](/pricing) indique les limites.

## L'aperçu montre des pages

La plupart des éditeurs Markdown en ligne affichent une seule longue page web. markoto affiche des pages A4 ou Letter avec marges, en-têtes, pieds de page et numéros de page : vous voyez où un tableau se coupe ou où tombe un titre avant d'imprimer. Le PDF utilise la même mise en page.

::tour-clip{scene="write"}
::

## Plus que du Markdown de base

En plus de CommonMark et de GitHub Markdown (tableaux, listes de tâches, notes de bas de page, encarts), l'éditeur affiche les formules LaTeX, les diagrammes Mermaid, le code coloré, une table des matières et les sauts de page. Le menu **Insérer** ajoute chacun d'eux pour vous si vous ne vous souvenez pas de la syntaxe. L'[aide-mémoire Markdown](/fr/markdown-cheat-sheet) montre chaque exemple à côté de son résultat.

::flow-strip{id="rich-content" frames="20" caption="Un bloc de code, un encart, une formule et un diagramme Mermaid, affichés au fil de la frappe."}
::

## Partager un lien

Chaque document a son propre lien. Copiez-le depuis la fenêtre de partage et envoyez-le ; la personne qui l'ouvre voit vos modifications pendant que vous tapez. Le propriétaire peut mettre le lien en lecture seule ou le protéger par un mot de passe, et la fenêtre affiche aussi le lien sous forme de QR code. Détails dans la [documentation sur le partage](/docs/sharing) (en anglais).

::flow-strip{id="quick-share" frames="13" caption="La fenêtre de partage, avec le lien du document en haut et le mode d'accès en dessous."}
::

## Votre texte reste du Markdown

Le document est du Markdown pur, et **Fichier › Exporter › Markdown** le télécharge sous forme de fichier `.md`. Le thème et les réglages du document vont dans un court bloc frontmatter en tête de fichier, que les autres outils ignorent et que markoto relit à l'import. **Fichier › Importer** ouvre les fichiers `.md` et convertit en Markdown les fichiers Word, PDF, PowerPoint, Excel, HTML et EPUB.

## Limites

- **Pas de mode hors ligne.** L'éditeur a besoin d'une connexion pour ouvrir un document. Une courte coupure pendant la frappe ne pose pas de problème : vos modifications se synchronisent à votre retour.
- **Vous modifiez la source.** La partie gauche est du texte Markdown avec une barre d'outils, pas un traitement de texte. L'aperçu n'est pas modifiable.
- **Pas d'application de bureau.** markoto fonctionne dans le navigateur, sur ordinateur comme sur téléphone.

Vous comparez des éditeurs ? Voyez markoto face à [HackMD](/compare/hackmd) et [HedgeDoc](/compare/hedgedoc) (en anglais).

## Questions

::faq{json-ld}
---
items:
  - q: L'éditeur Markdown en ligne est-il gratuit ?
    a: Oui. Écrire, partager et exporter sont gratuits sur markoto.app, avec ou sans compte.
  - q: Faut-il s'inscrire ?
    a: Non. Vous pouvez créer et partager des documents sans compte. Ils sont supprimés après 30 jours sans modification. Avec un compte gratuit, vos documents sont conservés et restent privés tant que vous ne les partagez pas.
  - q: Mon texte est-il enregistré ?
    a: L'exemple de cette page n'est pas enregistré. Un document est enregistré sur le serveur au fil de la frappe, et chaque modification est conservée dans son historique.
  - q: Plusieurs personnes peuvent-elles modifier en même temps ?
    a: Oui. Toutes les personnes qui ouvrent le lien voient les curseurs et les modifications des autres en direct, sans compte.
  - q: Puis-je télécharger mon document ?
    a: Oui, en fichier Markdown ou en PDF, depuis le menu Fichier.
  - q: Est-ce que ça fonctionne sur téléphone ?
    a: Oui. Sur téléphone, l'éditeur bascule entre l'écriture et l'aperçu paginé.
---
::

::cta{title="Commencez à écrire dans votre navigateur." secondary-label="Lire la documentation" secondary-to="/docs/getting-started/quick-share"}
Un nouveau document s'ouvre en quelques secondes. Sans inscription.
::
