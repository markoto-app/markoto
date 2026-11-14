---
title: Éditeur Markdown collaboratif pour les équipes
description: Modifiez du Markdown à plusieurs en temps réel - curseurs en direct, commentaires, chaque modification avec diff et restauration, rôles par équipe.
keywords:
  - éditeur markdown collaboratif
  - collaboration markdown en temps réel
  - éditeur markdown partagé
  - éditeur markdown pour équipe
  - édition collaborative markdown
# Menu label once reviewed (group + order come from the English page).
navLabel: "Édition collaborative"
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Un éditeur Markdown collaboratif

Envoyez le lien d'un document, et toutes les personnes qui l'ouvrent modifient le même texte en même temps. Vous voyez les curseurs et les noms des autres, les modifications arrivent au fil de la frappe, et il n'y a ni bouton Enregistrer ni conflit de fusion. Commentaires, historique complet et espaces de travail avec rôles sont inclus.

::tour-clip{scene="collab"}
::

## Écrire en même temps

Deux personnes peuvent taper dans le même paragraphe sans s'écraser mutuellement : markoto fusionne les modifications au moment où elles sont faites. La barre du haut montre qui est dans le document, et chaque personne a un curseur de sa propre couleur. Cela fonctionne aussi sans compte : un document anonyme peut être modifié par toute personne disposant du lien.

::flow-strip{id="two-writers-one-document" frames="07,10"}
---
captions:
  - Un paragraphe tapé par une deuxième personne apparaît dans l'éditeur de la première. Les avatars en haut montrent qui est dans le document.
  - Un commentaire de la deuxième personne arrive dans la barre latérale, ancré à la ligne qu'il concerne.
---
::

## Discuter dans les commentaires

Sélectionnez un passage et ajoutez un commentaire. Le fil est ancré à ces mots et les suit quand le texte autour change. Les autres répondent en dessous ; dans un espace de travail, vous pouvez mentionner des membres avec `@`. Un fil résolu s'efface du chemin mais reste lisible. Si l'assistant IA est configuré, `@markoto` dans un commentaire lui demande de répondre ou de faire la modification.

::flow-strip{id="have-a-discussion" frames="11,15"}
---
captions:
  - Une réponse apparaît sous le commentaire dès qu'elle est envoyée.
  - Les fils résolus passent dans une section à part, où ils restent lisibles.
---
::

## Chaque modification, avec son diff

L'onglet Activité liste chaque modification avec son auteur, sa date et le nombre de lignes changées. Ouvrez une entrée pour voir le diff. Les commentaires, les changements de titre et de thème et les modifications de l'IA figurent dans la même liste. **Restaurer** remet le document dans l'état où il était juste avant une modification, pour tout le monde, et la restauration apparaît elle-même dans la liste : on peut donc l'annuler aussi.

::flow-strip{id="see-what-changed-in-past-edits" frames="05" caption="Une entrée de l'onglet Activité, ouverte sur son diff : lignes ajoutées en vert, lignes supprimées en rouge."}
::

::flow-strip{id="restore-an-earlier-version" frames="09" caption="Après une restauration : le texte est revenu, et la restauration figure dans l'onglet Activité comme toute autre modification."}
::

Pour aller plus loin, dans la documentation (en anglais) : [voir ce qui a changé](/docs/import-export/see-changes) et [restaurer une version antérieure](/docs/import-export/restore).

## Espaces de travail et rôles

Un espace de travail regroupe les documents d'une équipe. Vous invitez des personnes par e-mail, et elles rejoignent l'espace en acceptant l'invitation. Il y a trois rôles : les **administrateurs** gèrent les membres et l'espace, les **éditeurs** écrivent et commentent, les **lecteurs** lisent. Un espace de travail garde toujours au moins un administrateur.

::flow-strip{id="roles-inside-a-workspace" frames="08" caption="La liste des membres : chaque personne a un rôle, qu'un administrateur change depuis la puce à côté du nom."}
::

Les documents hors d'un espace de travail se partagent par lien. Le propriétaire choisit l'un des quatre modes : privé, modifiable par toute personne disposant du lien, lisible par toute personne disposant du lien, ou protégé par mot de passe. Voir la documentation sur le [partage](/docs/sharing) et les [espaces de travail](/docs/workspaces) (en anglais).

## L'IA, un collaborateur que vous voyez

Quand l'assistant IA modifie un document, il le rejoint comme une autre personne : son curseur et ses modifications apparaissent en direct pour tout le monde, dans le rouge de markoto, et ses modifications figurent dans l'historique comme celles des autres. Vous pouvez restaurer ce qu'il a changé. L'IA demande un compte ; sur markoto.app, elle fonctionne avec une petite allocation mensuelle ou avec [votre propre fournisseur d'IA](/docs/ai/provider).

## Ce qu'il ne fait pas

- **Pas de mode suggestion.** Il n'y a pas de modifications suivies à accepter ou refuser. Les personnes qui ont le droit de modifier changent le texte directement, et l'historique conserve chaque version.
- **Pas de mode hors ligne.** Un document a besoin d'une connexion pour s'ouvrir. Une courte coupure pendant la frappe ne pose pas de problème : vos modifications se synchronisent à votre retour.
- **Du Markdown, pas un traitement de texte.** Tout le monde modifie la source Markdown ; l'aperçu paginé se trouve à côté.

## L'héberger pour votre équipe

markoto peut tourner sur votre propre serveur, avec une connexion par le fournisseur d'identité de votre entreprise. Voir [héberger markoto vous-même](/self-hosted-markdown-editor) (en anglais).

Vous hésitez entre plusieurs outils ? Voyez markoto face à [HackMD](/compare/hackmd), [HedgeDoc](/compare/hedgedoc) et [Google Docs](/compare/google-docs) (en anglais). Les limites de l'offre gratuite figurent sur la [page des tarifs](/pricing).

## Questions

::faq{json-ld}
---
items:
  - q: La collaboration en temps réel est-elle gratuite ?
    a: Oui. La co-édition en direct, les commentaires et l'historique font partie de l'offre gratuite sur markoto.app, et les documents anonymes peuvent être modifiés à plusieurs sans compte.
  - q: Combien de personnes peuvent modifier un document en même temps ?
    a: Il n'y a pas de limite de collaborateurs par document. Toute personne disposant d'un lien de modification, ou ayant le rôle d'éditeur dans l'espace de travail, peut participer.
  - q: Les collaborateurs ont-ils besoin d'un compte ?
    a: Pas pour un document partagé avec un lien de modification ou de lecture. Pour rejoindre un espace de travail, il faut un compte avec l'adresse e-mail invitée.
  - q: Puis-je voir qui a changé quoi ?
    a: Oui. L'onglet Activité liste chaque modification avec son auteur et sa date, affiche le diff et peut remettre le document dans l'état où il était avant n'importe quelle modification.
  - q: Existe-t-il un mode suggestion ou de suivi des modifications ?
    a: Non. Les modifications vont directement dans le texte. L'historique conserve chaque version, ce qui permet de relire et d'annuler une modification après coup.
  - q: Pouvons-nous l'héberger nous-mêmes ?
    a: Oui. markoto s'installe sur un serveur Linux avec Docker Compose et un seul script, avec une connexion par votre propre fournisseur OpenID Connect.
---
::

::cta{title="Écrivez à plusieurs, dès maintenant." secondary-label="Lire la documentation sur la collaboration" secondary-to="/docs/collaborate/live-collab"}
Créez un document et envoyez le lien. Votre collaborateur n'a pas besoin de compte.
::
