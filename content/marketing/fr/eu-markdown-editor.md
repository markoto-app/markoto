---
title: Un éditeur Markdown hébergé dans l'UE
description: markoto.app stocke les documents en France, utilise des fournisseurs d'IA établis dans l'UE et seulement des cookies essentiels. RGPD et auto-hébergement.
keywords:
  - éditeur markdown rgpd
  - éditeur markdown hébergé en europe
  - éditeur markdown hébergé dans l'ue
  - alternative google docs rgpd
  - éditeur collaboratif conforme rgpd
# Menu label once reviewed (group + order come from the English page).
navLabel: "Hébergé dans l'UE"
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). See docs/TRANSLATION-REVIEW.md.
# Legal facts follow content/legal/privacy/fr.md (version 8).
reviewed: false
---

# Un éditeur Markdown hébergé dans l'UE

markoto est un éditeur Markdown collaboratif exploité par une entreprise suisse. Sur markoto.app, vos documents, vos images et les sauvegardes sont stockés dans l'UE (France), et les fonctionnalités d'IA reposent sur des fournisseurs établis dans l'UE. Cette page indique où vont les données et ce que nous ne prétendons pas, pour que vous puissiez la confronter à vos propres exigences. Le texte qui fait foi est la [politique de confidentialité](/legal/privacy) ; en cas de divergence entre cette page et la politique, c'est la politique qui s'applique.

## Qui l'exploite

markoto.app est exploité par **LatentSpace Labs GmbH**, à Zurich (Suisse). La politique de confidentialité est rédigée à la fois pour la loi fédérale suisse sur la protection des données (LPD) et pour le règlement général sur la protection des données de l'UE (RGPD). Le Conseil fédéral suisse reconnaît que les États de l'UE et de l'EEE offrent un niveau de protection adéquat, et la Commission européenne reconnaît le caractère adéquat de la protection en Suisse : les données peuvent donc circuler entre les deux sans garanties supplémentaires.

## Où vos données sont stockées

- **Documents, commentaires, historique et données de compte** : dans la base PostgreSQL gérée d'OVHcloud, en France.
- **Images et sauvegardes quotidiennes de la base** : dans le stockage d'objets d'OVHcloud, en France. Les sauvegardes sont chiffrées et conservées environ 30 jours.
- **Fichiers de la base de connaissances** que vous téléversez dans un espace de travail : convertis en texte sur nos propres serveurs, après quoi le fichier d'origine est supprimé. Seuls le texte et son index de recherche sont conservés.

## Qui d'autre reçoit des données

Voici les prestataires (sous-traitants ultérieurs) auxquels markoto.app fait appel aujourd'hui, tirés de la même liste que la [page des sous-traitants ultérieurs](/legal/sub-processors) :

::sub-processors
::

En résumé : le stockage et tous les fournisseurs d'IA se trouvent dans l'UE. Les prestataires établis aux États-Unis n'interviennent que pour des tâches précises :

- **Google et GitHub**, uniquement si vous choisissez de vous connecter avec eux. markoto lit votre nom, votre adresse e-mail vérifiée et l'identifiant de votre compte, et rien d'autre.
- **Resend** achemine les quelques e-mails que markoto envoie (par exemple les invitations et les confirmations de suppression de compte).
- **Sentry** reçoit les rapports d'erreurs. Ils sont stockés dans la région UE de Sentry (Francfort) ; la société américaine peut y avoir accès pour l'assistance et l'exploitation.

Ces transferts reposent sur le Data Privacy Framework UE-États-Unis et le Swiss-U.S. Data Privacy Framework, avec les clauses contractuelles types à titre subsidiaire, comme le décrit la politique de confidentialité.

## Fonctionnalités d'IA

L'assistant d'écriture, la saisie vocale, la recherche web, la récupération de pages et la génération d'images passent tous par la propre passerelle d'IA de markoto vers des fournisseurs établis dans l'UE : Mistral AI (France ; centres de données dans l'UE et l'AELE) pour le texte et la voix, Jina AI (Allemagne) pour la recherche dans la base de connaissances et la lecture de pages web, Staan (France) pour la recherche web et Black Forest Labs pour les images (région UE dédiée).

- **Rien n'est envoyé à un fournisseur d'IA si vous n'utilisez pas l'IA.** Le contenu d'un document n'est envoyé que lorsque vous utilisez l'assistant ou téléversez des fichiers dans la base de connaissances d'un espace de travail. L'IA demande un compte ; les visiteurs anonymes ne peuvent pas l'utiliser.
- **Pas d'entraînement sur votre contenu.** markoto n'entraîne pas de modèles. Jina AI et Staan indiquent ne pas utiliser les données des requêtes pour l'entraînement ; auprès de Mistral AI et de Black Forest Labs, markoto a exercé son droit d'opposition à l'entraînement (opt-out).
- **Votre propre fournisseur, votre choix.** Si vous connectez votre propre fournisseur d'IA sous Paramètres › Fournisseur d'IA, vos requêtes d'IA vont à ce fournisseur, dans le cadre de votre propre accord avec lui. Il n'est alors pas un sous-traitant ultérieur de markoto, et le lieu du traitement dépend du fournisseur choisi.
- **Les requêtes et les appels d'outils** sont conservés 90 jours pour l'examen des abus, puis supprimés.

::flow-strip{id="use-your-own-ai-provider" frames="06" caption="Paramètres › Fournisseur d'IA : l'assistant d'écriture connecté à un fournisseur de votre choix."}
::

## Pas de pistage

markoto.app n'utilise que le stockage strictement nécessaire au fonctionnement du service : la session de connexion, votre langue et quelques clés pour les documents anonymes. Il n'y a ni statistiques d'usage, ni enregistrement de sessions, ni publicité, ni pistage intersites, et donc pas de bandeau de cookies. La politique de confidentialité liste chaque cookie et chaque clé de stockage.

Les documents ne sont pas indexés par les moteurs de recherche : chaque page de document envoie une instruction `noindex`. Un lien peut tout de même circuler ; considérez donc un lien partagé comme public.

## Pour les écoles, les équipes et les entreprises

- **Accord de traitement des données.** Quand vous créez un espace de travail, markoto agit comme votre sous-traitant pour les contenus que votre équipe y place, dans le cadre de l'[accord de traitement des données](/legal/dpa). Vous l'acceptez en créant votre premier espace de travail.
- **Export.** Chaque utilisateur peut télécharger depuis son profil un ZIP de tout ce que markoto conserve à son sujet (documents en Markdown, commentaires, réglages, journaux).
- **Suppression.** La suppression d'un compte prend effet après un délai de grâce de 30 jours, que vous pouvez annuler. Ensuite, les documents, les espaces de travail dont vous êtes le seul membre et les données d'IA sont supprimés, et vos commentaires sur les documents d'autres personnes sont anonymisés.
- **Les nouveaux sous-traitants ultérieurs** sont annoncés aux propriétaires d'espaces de travail au moins 30 jours à l'avance.

::flow-strip{id="data-export" frames="06" caption="L'export de données sur la page de profil : l'archive est prête à être téléchargée."}
::

## Ce que markoto ne prétend pas

- **Pas de certification.** Il n'existe pas de « certificat RGPD » pour un produit, et markoto ne détient aucune certification de sécurité propre (ni ISO 27001, ni SOC 2). Le fournisseur de stockage publie ses propres certifications.
- **Pas de chiffrement de bout en bout.** Les serveurs de markoto peuvent lire vos documents ; ils en ont besoin pour afficher les pages, produire les PDF et faire tourner l'IA. Les données sont chiffrées en transit et au repos. Si le serveur ne doit pas pouvoir lire votre contenu, utilisez plutôt un outil chiffré de bout en bout.
- **Pas un avis juridique.** C'est à vous ou à votre délégué à la protection des données de décider si markoto répond aux obligations de votre organisation. La politique de confidentialité, l'accord de traitement des données et la liste des sous-traitants ultérieurs sont là pour rendre cette vérification possible.

## Le contrôle total : l'héberger vous-même

Si vos données ne doivent pas quitter votre propre infrastructure, [hébergez markoto vous-même](/self-hosted-markdown-editor) (en anglais). Une instance auto-hébergée fait tourner le même code que markoto.app, avec Docker Compose sur votre propre serveur, une connexion par votre propre fournisseur d'identité (OpenID Connect) et une IA limitée aux fournisseurs que vous configurez, modèles locaux compris. L'aperçu et l'export PDF ne chargent rien depuis des tiers : une instance fonctionne donc aussi sur un réseau isolé. Sur votre propre instance, vous êtes l'exploitant et le responsable du traitement ; les prestataires de markoto.app n'interviennent pas.

## Questions

::faq{json-ld}
---
items:
  - q: Où mes documents sont-ils stockés ?
    a: Sur markoto.app, chez OVHcloud en France, dans une base PostgreSQL gérée. Les images et les sauvegardes quotidiennes chiffrées se trouvent dans le stockage d'objets d'OVHcloud, également en France.
  - q: markoto est-il conforme au RGPD ?
    a: markoto.app est exploité de manière à respecter le RGPD et la LPD suisse, et la politique de confidentialité explique comment. Il n'existe pas de certification RGPD officielle pour les produits, markoto n'en revendique donc aucune. Confrontez la politique de confidentialité, l'accord de traitement des données et la liste des sous-traitants ultérieurs à vos propres exigences.
  - q: Des entreprises américaines reçoivent-elles mes documents ?
    a: Non. Les documents sont stockés dans l'UE et les fournisseurs d'IA sont établis dans l'UE. Des prestataires américains interviennent pour la connexion avec Google ou GitHub (si vous la choisissez), les e-mails transactionnels et les rapports d'erreurs.
  - q: markoto utilise-t-il mes documents pour entraîner l'IA ?
    a: Non. markoto n'entraîne pas de modèles, et s'est opposé à l'entraînement auprès des fournisseurs d'IA qui le prévoient.
  - q: Existe-t-il un accord de traitement des données ?
    a: Oui, pour les propriétaires d'espaces de travail. markoto agit comme sous-traitant pour les contenus de votre espace de travail dans le cadre de son accord de traitement des données, que vous acceptez en créant un espace de travail.
  - q: markoto est-il chiffré de bout en bout ?
    a: Non. Le serveur doit lire les documents pour afficher les pages et les PDF. Les données sont chiffrées en transit et au repos.
  - q: Puis-je héberger markoto moi-même ?
    a: Oui. Le code source de markoto est disponible (source-available), et markoto s'installe sur votre propre serveur Linux avec Docker Compose. Aucune donnée ne passe alors par markoto.app.
---
::

::cta{title="Écrivez dans un éditeur hébergé dans l'UE." secondary-label="Lire la politique de confidentialité" secondary-to="/legal/privacy"}
Gratuit sur markoto.app, sans inscription pour commencer un document.
::
