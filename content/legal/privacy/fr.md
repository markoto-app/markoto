---
slug: privacy
locale: fr
version: 8
effectiveDate: 2026-11-03
translationStatus: machine-translated
---

# Politique de confidentialité

> **En bref :** markoto conserve les documents que vous rédigez, les commentaires que vous laissez et le minimum nécessaire pour gérer votre compte. Le service est gratuit ; les offres payantes ne sont pas encore proposées. Les fonctionnalités d'IA reposent sur des fournisseurs établis dans l'UE (Mistral AI pour le texte et la voix, Jina AI pour les embeddings et la récupération de pages isolées, Staan pour la recherche web, Black Forest Labs pour la génération d'images), sauf si vous connectez votre propre fournisseur d'IA : dans ce cas, votre contenu d'IA est envoyé au fournisseur que vous avez choisi. Nous n'utilisons que des cookies essentiels : ni statistiques d'usage, ni pistage, ni publicité. Nous ne vendons pas vos données et nous n'entraînons pas d'IA sur votre contenu. Vous pouvez exporter les données que nous détenons sur vous et supprimer votre compte à tout moment depuis vos paramètres.

**Sommaire**

[[toc]]

---

## 1. Qui nous sommes

markoto est exploité par **{{controllerName}}** ({{controllerAddress}}). Pour toute question relative à la vie privée, écrivez à **{{privacyContactEmail}}**.

La présente politique est rédigée de manière à satisfaire à la fois à la **loi fédérale suisse sur la protection des données** (nouvelle LPD, nLPD, en vigueur depuis le 1er septembre 2023) et, lorsqu'il nous est applicable, au **règlement général sur la protection des données** de l'UE (règlement (UE) 2016/679, « RGPD »). Le RGPD nous est applicable parce que nous proposons markoto à des personnes se trouvant dans l'UE et l'EEE.

Nous sommes le **responsable du traitement** des données personnelles que vous nous fournissez directement : votre compte, les documents anonymes que vous créez, les signalements d'abus et, si vous vous y inscrivez, la liste d'attente des offres payantes. Lorsque vous utilisez markoto dans un espace de travail appartenant à un tiers, le propriétaire de cet espace est le responsable du traitement des contenus placés dans son espace de travail, et nous agissons en tant que **sous-traitant** pour son compte dans le cadre de notre accord de traitement des données ([/legal/dpa](/legal/dpa)).

## 2. Quelles données nous traitons et pourquoi

Nous ne collectons que ce dont chaque finalité a besoin, et nous vous indiquons quelle est cette finalité. La liste complète des finalités de traitement, avec la base juridique, les catégories de données, la durée de conservation et les destinataires, figure dans le registre du point 13, généré à partir de notre registre interne. Toute modification de ce registre constitue une modification substantielle de la présente politique et en change la version (voir le point 14).

En résumé, nous traitons :

- **Données de compte :** nom, adresse e-mail, identifiant fourni par votre fournisseur de connexion (GitHub ou Google), langue, confirmation d'âge et versions de nos politiques que vous avez acceptées.
- **Contenus :** documents, commentaires, images, fichiers de la base de connaissances, thèmes et auteur de chaque modification.
- **Utilisation de l'IA :** requêtes, contexte du document et résultats de l'IA, lorsque vous utilisez les fonctionnalités d'IA.
- **Données techniques :** adresses IP (utilisées sous une forme éphémère pour la limitation de débit et conservées uniquement sous forme tronquée dans les journaux), type de navigateur, rapports d'erreurs.

## 2b. Documents anonymes, vérification anti-robots et signalements d'abus

**Documents anonymes.** Vous pouvez créer un document sans compte. Avant que votre navigateur ne crée le premier, vous cochez une case pour accepter nos conditions d'utilisation et confirmer avoir au moins 16 ans, et votre navigateur résout une vérification anti-robots. Nous enregistrons avec le document la version des conditions que vous avez acceptée et l'heure, ainsi qu'une empreinte (hash) d'une clé de créateur aléatoire que votre navigateur conserve dans un cookie afin que lui seul puisse supprimer le document. Votre navigateur mémorise également votre acceptation dans un cookie, de sorte que la question ne vous est reposée que lorsque les conditions changent (voir le point 9). Nous ne vous demandons ni votre nom ni votre adresse e-mail. Toute personne disposant du lien peut ouvrir le document ; n'y placez pas de données personnelles d'autres personnes. Les documents créés sans compte sont signalés comme contenu d'utilisateur, avec un lien permettant de les signaler. Les documents anonymes sont supprimés automatiquement après **30 jours** sans activité, avec l'acceptation des conditions enregistrée avec eux.

**Moteurs de recherche.** Chaque page de document, avec ou sans compte, indique aux moteurs de recherche de ne pas l'indexer (un en-tête `X-Robots-Tag: noindex` et une balise meta correspondante). Notre `robots.txt` ne bloque délibérément pas les documents, car un moteur de recherche doit pouvoir récupérer une page pour voir cette instruction. Un lien vers un document peut néanmoins être transmis ; considérez donc un lien partagé comme public.

**Vérification anti-robots.** La vérification anti-robots est une énigme de preuve de travail (proof of work, ALTCHA) que notre propre serveur émet et que votre navigateur résout. Elle ne fait intervenir aucun tiers et ne dépose aucun cookie. Nous vérifions la solution et conservons une empreinte de l'énigme utilisée pendant environ 20 minutes afin qu'elle ne puisse pas être réutilisée. Pour empêcher les créations en masse, nous comptons les requêtes anonymes par adresse IP (pour l'IPv6, par réseau /64) dans une mémoire éphémère ; ces compteurs ne contiennent aucun contenu et expirent en moins d'une journée.

**Signalements d'abus.** Toute personne peut signaler un contenu, y compris sans compte (le signalement est alors protégé par la même vérification anti-robots). Nous enregistrons l'adresse du contenu signalé, votre explication, la catégorie, votre nom et votre adresse e-mail (facultatifs uniquement pour les signalements de contenus pédopornographiques), la langue que vous avez utilisée, le moment où vous avez confirmé que votre signalement est fait de bonne foi, l'heure, une adresse IP tronquée et une empreinte (hash) de l'agent utilisateur de votre navigateur (contre les signalements en masse), ainsi que votre compte si vous étiez connecté. Nous les utilisons pour traiter votre signalement, en accuser réception et vous informer de notre décision par e-mail, et, lorsque la loi l'exige, informer les autorités. Si nous retirons ou restreignons un document, nous adressons un exposé des motifs à son propriétaire par e-mail ; celui-ci ne vous nomme pas. Pour un document créé sans compte, nous ne pouvons pas joindre son créateur et nous consignons l'exposé comme impossible à remettre. Nous conservons avec le signalement une copie de chaque notification que nous envoyons ou que nous n'avons pas pu remettre. Nous conservons un signalement tant que le dossier est ouvert et le supprimons, avec ces notifications, **1 an après la clôture du dossier** (lorsque nous avons agi ou décidé de ne pas agir). Votre export de données comprend les signalements que vous avez déposés en étant connecté, avec les notifications qui vous ont été envoyées, ainsi que les exposés des motifs que vous avez reçus en tant que propriétaire d'un document.

## 3. Base juridique

Au regard du RGPD, chaque traitement repose sur l'une des bases juridiques suivantes (article 6 du RGPD). Au regard de la LPD, nous traitons les données personnelles conformément à ses principes (art. 6 LPD) et, lorsqu'un motif justificatif est nécessaire, nous nous fondons sur les mêmes motifs (art. 31 LPD).

- **Contrat** (article 6, paragraphe 1, point b, du RGPD) : tout ce qui est nécessaire à la fourniture du service que vous utilisez : comptes, documents, collaboration, assistance de l'IA et, dès que des offres payantes seront proposées, facturation.
- **Obligation légale** (article 6, paragraphe 1, point c, du RGPD) : le journal d'audit de sécurité, le traitement des signalements d'abus et des injonctions légales (règlement sur les services numériques de l'UE) et, dès que des offres payantes seront proposées, la conservation des données de facturation imposée par le droit fiscal.
- **Intérêt légitime** (article 6, paragraphe 1, point f, du RGPD) : la sécurité du service et la lutte contre les abus (limites de débit, vérification anti-robots et acceptation des conditions pour les documents créés sans compte, surveillance des erreurs) ainsi que les invitations aux espaces de travail. Vous pouvez vous opposer au traitement fondé sur cette base (voir le point 6).
- **Consentement** (article 6, paragraphe 1, point a, du RGPD) : uniquement pour la liste d'attente des offres payantes (vous cochez la case puis confirmez l'e-mail que nous vous envoyons). Vous pouvez retirer votre consentement à tout moment au moyen du lien de désinscription.

## 4. Destinataires et transferts internationaux

Nous faisons appel à un petit nombre de prestataires (« sous-traitants ultérieurs ») liés par des accords écrits de traitement des données (article 28 du RGPD, art. 9 LPD). La liste à jour figure à l'adresse [/legal/sub-processors](/legal/sub-processors). Elle n'indique que les prestataires réellement utilisés par ce déploiement : Stripe (paiement) n'y apparaît que lorsque les offres payantes sont activées, et un fournisseur d'IA que **vous** connectez vous-même (voir le point 8) n'est pas notre sous-traitant ultérieur et n'y figure pas.

**Où vont vos données.** Nous sommes établis en Suisse. Notre base de données, notre stockage de fichiers, nos sauvegardes et nos fournisseurs d'IA se trouvent dans l'UE (France et Allemagne). Le Conseil fédéral suisse reconnaît que l'UE et l'EEE offrent un niveau de protection des données adéquat, et la Commission européenne reconnaît le caractère adéquat de la protection en Suisse ; ces transferts ne nécessitent donc aucune garantie supplémentaire.

Certains prestataires sont établis aux **États-Unis** :

| Prestataire | Ce qu'il reçoit | Garantie |
| --- | --- | --- |
| Google LLC | Connexion, uniquement si vous choisissez « Se connecter avec Google » | Data Privacy Framework, avec clauses contractuelles types à titre subsidiaire |
| GitHub, Inc. | Connexion, uniquement si vous choisissez « Se connecter avec GitHub » | Data Privacy Framework, avec clauses contractuelles types à titre subsidiaire |
| Resend, Inc. | Adresse du destinataire et contenu des e-mails que nous vous envoyons | Data Privacy Framework, avec clauses contractuelles types à titre subsidiaire |
| Functional Software, Inc. (Sentry) | Rapports d'erreurs : détails techniques, page ou requête concernée, votre identifiant utilisateur interne. Stockés dans la région UE de Sentry (Francfort) ; la société américaine peut y avoir accès pour l'assistance et l'exploitation | Data Privacy Framework, avec clauses contractuelles types à titre subsidiaire |
| Stripe, Inc. | Données de facturation, uniquement dès que des offres payantes seront proposées (pas utilisé actuellement) | Data Privacy Framework, avec clauses contractuelles types à titre subsidiaire |

Pour ces transferts, nous nous appuyons, pour les destinataires certifiés, sur le **cadre de protection des données UE-États-Unis** (Data Privacy Framework, décision d'adéquation de la Commission européenne du 10 juillet 2023) et sur le **Swiss-U.S. Data Privacy Framework** (reconnu par le Conseil fédéral suisse avec effet au 15 septembre 2024), et à défaut sur les **clauses contractuelles types** de la Commission européenne (2021/914), adaptées au droit suisse comme l'exige le PFPDT.

Nous informons les propriétaires d'espaces de travail au moins 30 jours à l'avance de tout nouveau sous-traitant ultérieur.

## 5. Lieu de stockage et conservation

Les données de l'application et les documents sont stockés dans la base PostgreSQL gérée et le stockage d'objets d'OVHcloud, dans l'UE (France). Le traitement lié à l'IA est effectué par des fournisseurs établis dans l'UE : Mistral AI (France), Jina AI (Allemagne), Staan (France) et Black Forest Labs (région UE dédiée), via notre propre proxy LiteLLM. Tant que le service est gratuit, nous ne traitons aucune donnée de paiement. Les rapports d'erreurs sont traités par Sentry dans sa région UE (Francfort). Les e-mails transactionnels sont envoyés via Resend.

La conservation suit le registre du point 13. En règle générale :

- **Les données de compte** sont conservées jusqu'à ce que vous supprimiez votre compte.
- **Les documents et contenus** sont conservés jusqu'à ce que vous les supprimiez ou supprimiez votre compte.
- **Les documents anonymes** (créés sans connexion et ne faisant pas partie d'un espace de travail) sont supprimés automatiquement après **30 jours** sans activité. Les documents appartenant à un compte et les documents d'espace de travail ne sont pas supprimés automatiquement.
- **Les enregistrements des requêtes à l'IA et des appels d'outils** sont conservés 90 jours pour l'examen des abus, puis supprimés.
- **Les données d'utilisation de l'IA** (pour chaque requête à une IA que nous payons : coût, modèle, heure et votre identifiant interne d'utilisateur) sont conservées 90 jours par notre proxy LiteLLM, et vos totaux mensuels jusqu'à la remise à zéro mensuelle de l'allocation. Nous les utilisons pour appliquer la limite par compte et la réserve mensuelle commune. Les requêtes envoyées à votre propre fournisseur sont également enregistrées, avec un coût nul, pour appliquer les limites de débit.
- **Journal d'audit.** Notre journal d'audit de sécurité enregistre qui a modifié des contrôles d'accès, supprimé des contenus ou effectué d'autres actions pertinentes pour la sécurité, avec des adresses IP tronquées (IPv4 en /24, IPv6 en /48). Les entrées sont supprimées automatiquement après **2 ans**. Si vous supprimez votre compte avant, votre identifiant de compte en est retiré immédiatement.
- **Sauvegardes.** Nous effectuons une sauvegarde chiffrée de la base de données une fois par jour et conservons les 30 dernières ; chaque sauvegarde est donc conservée environ **30 jours**. Les données que vous supprimez restent ainsi dans nos sauvegardes pendant 30 jours au plus avant d'être écrasées. Notre fournisseur de base de données OVHcloud conserve également ses propres sauvegardes automatiques pendant une durée limitée. Nous n'utilisons les sauvegardes que pour rétablir le service après une panne.
- **Les données de facturation** n'existent pas tant que le service est gratuit. Dès que des offres payantes seront proposées, elles seront conservées pendant la durée imposée par le droit fiscal (10 ans en Suisse).
- **E-mails transactionnels.** Resend conserve les enregistrements de livraison (destinataire, heure, statut) pendant 30 jours. Nous ne conservons pas de copie des e-mails que nous envoyons.
- **Liste d'attente des offres payantes.** Si vous vous inscrivez sur la liste d'attente depuis la page des tarifs, nous conservons votre adresse e-mail, la langue utilisée lors de l'inscription, la version du texte de consentement que vous avez acceptée, la date de l'inscription et de la confirmation et, si vous étiez connecté, un lien vers votre compte. Nous ne conservons pas votre adresse IP. Nous l'utilisons uniquement pour vous informer du lancement des offres payantes. Votre inscription n'est prise en compte qu'après un clic sur le lien de confirmation envoyé par e-mail (double opt-in) ; les inscriptions non confirmées sont supprimées après 7 jours. Chaque e-mail contient un lien de désinscription qui supprime immédiatement votre inscription ; à défaut, nous supprimons la liste au plus tard 3 mois après l'envoi de l'annonce du lancement. La suppression de votre compte supprime également une inscription liée, et votre export de données l'inclut.
- **Invitations aux espaces de travail.** Lorsqu'un administrateur d'espace de travail invite quelqu'un par e-mail, nous conservons l'adresse saisie, le rôle proposé et l'auteur de l'invitation dans une invitation en attente. Personne ne devient membre sans l'accepter. L'invitation est supprimée dès qu'elle est acceptée, refusée ou retirée, et au plus tard au bout de 14 jours. Si l'envoi d'e-mails est configuré, un e-mail d'invitation contenant un lien à usage unique est envoyé via Resend. La suppression de votre compte supprime les invitations qui vous sont adressées, et votre export de données liste les invitations en attente reçues et envoyées.

## 5b. Ce qui se passe lorsque vous supprimez votre compte

Le bouton disponible à l'adresse [/settings/profile](/settings/profile) programme la suppression définitive de votre compte **dans 30 jours**. Pendant ce délai de grâce, votre compte reste utilisable et vous pouvez annuler depuis toute page affichant le bandeau de suppression. Une fois les 30 jours écoulés, ce qui suit s'exécute automatiquement, sans nouvelle confirmation et sans possibilité de rien récupérer.

### Ce qui est supprimé définitivement

- **Votre compte** : nom, e-mail, identifiants de connexion, préférences, langue, confirmation d'âge, versions des politiques acceptées.
- **Chaque document dont vous êtes propriétaire**, y compris les documents partagés avec des collaborateurs en mode édition. Les collaborateurs perdent l'accès en même temps. *Si vous souhaitez que des collaborateurs conservent un document, transférez-le-leur ou dupliquez-le au préalable sous leur compte.*
- **Chaque thème enregistré** sous votre compte.
- **Chaque espace de travail dont vous êtes le seul membre**, avec chaque document et fichier de connaissances qu'il contient. *Pour conserver le contenu d'un espace de travail, invitez un autre membre avant de supprimer votre compte, ou téléchargez d'abord les documents au moyen de l'export de données à l'adresse [/settings/profile](/settings/profile).*
- **Votre utilisation de l'IA** : requêtes passées (conservées 90 jours pour l'examen des abus), sessions d'IA ouvertes et paramètres d'un fournisseur d'IA personnel (apportez votre propre clé) avec leurs clés d'API chiffrées (voir le point 8).
- **Vos tâches d'export de données** et les fichiers ZIP préparés pour vous.
- **Votre fiche client Stripe, le cas échéant** (possible uniquement dès que des offres payantes seront proposées). Nous demandons à Stripe de la supprimer ; Stripe conserve les factures et enregistrements de paiement pendant la durée exigée par le droit fiscal.

Les données supprimées restent dans nos sauvegardes chiffrées de la base de données jusqu'à ce qu'elles soient écrasées, pendant 30 jours au plus (voir le point 5).

### Ce qui est anonymisé : conservé sans votre nom

- **Les commentaires que vous avez rédigés sur des documents dont vous n'êtes pas propriétaire.** Le texte reste pour que la conversation demeure intelligible pour les autres, mais votre nom et le lien avec votre compte sont remplacés par `[deleted user]`.
- **Les entrées du journal d'audit.** Nous conservons l'entrée du journal de sécurité, sans votre identifiant de compte. Ces entrées sont supprimées après 2 ans (voir le point 5).
- **Les entrées du journal d'activité.** Vos modifications, restaurations et changements de thème sur des documents dont vous n'êtes pas propriétaire restent dans le fil d'activité du document sous « Anonyme ». Les entrées concernant vos propres documents sont supprimées avec ceux-ci.
- **Les enregistrements de consentement.** Nous supprimons le lien avec votre compte mais conservons l'enregistrement, afin de pouvoir démontrer que le consentement a été donné (article 7, paragraphe 1, du RGPD).

### Espaces de travail dont vous êtes administrateur avec d'autres personnes

Si vous êtes administrateur d'un espace de travail comptant au moins un autre membre, **nous promouvons automatiquement l'un des membres restants au rang d'administrateur** : le membre le plus ancien, en privilégiant un administrateur existant, puis un éditeur, puis un lecteur. L'espace de travail et son contenu restent aux membres restants, et le nouvel administrateur en est informé. Le champ « propriétaire » de l'espace de travail est réattribué au nouvel administrateur ; l'accès ayant toujours été contrôlé par les rôles des membres, il s'agit d'une simple écriture comptable.

### Faites d'abord le ménage

La suppression d'un espace de travail supprime aussi les contenus que d'autres personnes ont placés dans un espace de travail dont vous êtes le seul membre. Avant de demander la suppression :

- Pour un espace de travail que vous souhaitez conserver : invitez au moins un collaborateur en tant qu'administrateur, afin qu'il en hérite.
- Pour un document qu'un collaborateur doit conserver : déplacez-le dans un espace de travail qui lui appartient, dupliquez-le sous son compte ou demandez-lui d'en télécharger une copie.
- Pour les fichiers de la base de connaissances que vous souhaitez conserver : téléchargez-les, car ils sont supprimés avec l'espace de travail.

### Votre export de données

Avant de supprimer votre compte, vous pouvez utiliser l'**export de données** à l'adresse [/settings/profile](/settings/profile) pour obtenir une archive ZIP de tout ce que nous détenons sur vous : documents en Markdown, vos commentaires, vos appartenances aux espaces de travail, journaux d'utilisation de l'IA, vos paramètres de fournisseur d'IA (URL, modèle et fonctionnalité, jamais la clé d'API), votre inscription sur la liste d'attente, vos enregistrements de consentement et, dès que des offres payantes existeront, l'historique de facturation.

### Combien de temps cela prend

Une tâche en arrière-plan s'exécute une fois par heure ; vos données sont donc purgées dans l'heure environ qui suit la fin du délai de grâce. Vous recevez un e-mail de confirmation lorsque la suppression a été exécutée (si nous disposons d'une adresse e-mail vous concernant).

### Annulation

Tant que la suppression n'a pas été exécutée, vous pouvez l'annuler en vous connectant et en cliquant sur « Annuler la suppression » dans le bandeau en haut de l'écran. Une fois exécutée, votre compte, vos sessions et vos contenus ont disparu.

## 6. Vos droits

Au titre du RGPD (articles 15 à 22) et de la LPD (art. 25 à 28 et 32), vous avez le droit :

- d'**accéder** aux données personnelles que nous détenons à votre sujet : utilisez l'export à l'adresse [/settings/profile](/settings/profile) ou écrivez-nous ;
- d'obtenir la **rectification** des données inexactes : modifiez votre profil ou écrivez-nous ;
- d'obtenir l'**effacement** de vos données : utilisez l'outil de suppression à l'adresse [/settings/profile](/settings/profile). Nous attendons 30 jours, puis supprimons définitivement ;
- d'obtenir la **limitation** du traitement : écrivez-nous ;
- de vous **opposer** au traitement fondé sur l'intérêt légitime : écrivez-nous ;
- à la **portabilité des données** : l'export fournit vos données aux formats JSON, NDJSON et Markdown, lisibles par machine ;
- de **retirer votre consentement** lorsque le traitement repose sur le consentement (actuellement uniquement la liste d'attente) : utilisez le lien de désinscription ;
- d'**introduire une réclamation** auprès d'une autorité de contrôle (voir le point 11).

Nous répondons dans un délai de 30 jours. Les demandes sont gratuites, sauf si elles sont manifestement infondées ou excessives.

## 7. Décision automatisée

Nous ne prenons aucune décision produisant des effets juridiques à votre égard ou vous affectant de manière significative de façon similaire sur le seul fondement d'un traitement automatisé. L'assistant IA se contente de faire des suggestions que vous acceptez ou rejetez. Les décisions de modération sont toujours prises par une personne (voir les conditions d'utilisation, article 8). Dès que des offres payantes seront proposées, Stripe évaluera automatiquement le risque de fraude des tentatives de paiement ; si un paiement est refusé sur cette base, vous pourrez demander un examen humain.

## 8. Fonctionnalités d'IA et transparence

markoto comprend un assistant d'écriture IA et une recherche dans la base de connaissances. Les requêtes d'IA passent par notre propre proxy LiteLLM vers les fournisseurs suivants, établis dans l'UE : Mistral AI (génération de texte, transcription vocale ; chaque requête est envoyée à son point d'accès européen, centres de données dans l'UE et dans des pays de l'AELE), Jina AI (embeddings pour la base de connaissances, extraction du contenu d'une page web isolée), Staan (recherche web via un index de recherche européen) et Black Forest Labs (génération d'images, région UE dédiée).

**Transparence de l'IA.** Lorsque l'IA travaille dans un document, elle apparaît comme un collaborateur distinct, ses réponses sont identifiées comme provenant de l'IA de markoto, et ses modifications sont enregistrées dans le journal d'activité du document comme effectuées par l'IA.

**Entraînement.** Nous n'utilisons pas votre contenu pour entraîner des modèles d'IA. Les conditions de nos fournisseurs diffèrent :

- **Jina AI** indique dans ses conditions qu'elle n'utilise pas les données des requêtes des clients, leurs entrées ni les contenus téléversés pour entraîner ses modèles.
- **Staan** indique que les données de recherche ne sont pas utilisées pour entraîner des modèles de langage.
- **Mistral AI** et **Black Forest Labs** peuvent, selon leurs conditions standard, utiliser le contenu transmis par l'API pour améliorer leurs modèles, sauf si le client s'y oppose (opt-out). Nous avons exercé cette option auprès des deux fournisseurs.

### Allocation d'IA gratuite

Si vous êtes connecté à votre compte et n'avez pas configuré votre propre fournisseur pour l'assistant de rédaction, l'assistant utilise notre **allocation d'IA gratuite** :

- **Modèle et fournisseur.** L'allocation utilise le modèle **GLM-5.3 Flash**, développé par Z.ai. Il est fourni et traité par **Mistral AI SAS** sur sa propre infrastructure, via son **point d'accès européen** (centres de données dans l'UE et dans des pays de l'AELE). Z.ai ne reçoit aucune donnée. Mistral AI traite les requêtes en tant que notre sous-traitant ultérieur, dans le cadre de notre accord avec elle, y compris l'exclusion de l'entraînement décrite ci-dessus.
- **Ce qui est envoyé.** Votre requête, les parties du document que l'assistant lit, les résultats des outils qu'il utilise (par exemple le texte d'une page récupérée ou des résultats de recherche à résumer) et, si vous posez une question sur une image, l'image. La réponse revient par le même chemin.
- **Qui peut l'utiliser.** Uniquement les utilisateurs connectés. Les visiteurs anonymes ne peuvent pas utiliser l'IA.
- **Limites.** Chaque compte dispose d'une limite mensuelle (actuellement 500 points d'IA, soit environ 0,50 dollar américain d'utilisation du modèle). En outre, tous les comptes gratuits partagent une réserve mensuelle commune. L'allocation n'est disponible que tant que la réserve de ce mois n'est pas épuisée ; lorsqu'elle l'est, l'assistant vous l'indique jusqu'au début du mois suivant. Pour appliquer ces limites, notre proxy LiteLLM enregistre pour chaque requête le coût, le modèle utilisé et l'heure, rattachés à votre identifiant interne d'utilisateur (conservation : voir le point 5).
- **Aucune garantie.** L'allocation est un supplément gratuit. Nous pouvons modifier le modèle, les limites ou la réserve, ou mettre fin à l'allocation, et nous ne garantissons pas qu'elle soit disponible à tout moment.
- **Votre propre clé la remplace.** Dès que vous configurez votre propre fournisseur pour l'assistant de rédaction (voir ci-dessous), vos requêtes sont envoyées à ce fournisseur et l'allocation ne s'y applique plus.

### Votre propre fournisseur d'IA (apportez votre propre clé)

Vous pouvez connecter votre propre compte de fournisseur d'IA (un service compatible OpenAI parmi les choix proposés dans les paramètres, par exemple Mistral AI ou OpenAI) sous **Paramètres → Fournisseur d'IA**, séparément pour la discussion, la génération d'images et la transcription vocale. Dans ce cas, le contenu nécessaire à cette fonctionnalité (votre requête, le contexte pertinent du document, les enregistrements vocaux et le résultat généré) est envoyé via notre proxy LiteLLM au **fournisseur que vous avez choisi, dans le cadre de votre propre accord avec celui-ci**. Nous ne choisissons pas ce fournisseur et il n'est pas notre sous-traitant ultérieur ; ses conditions et ses pratiques de protection des données, y compris le lieu où il traite les données et la question de savoir s'il s'entraîne sur votre contenu, sont celles de votre contrat avec lui. Nous conservons vos paramètres de fournisseur (URL du fournisseur, nom du modèle et votre clé d'API, chiffrée au repos) jusqu'à ce que vous les supprimiez ou supprimiez votre compte. Seuls les quatre derniers caractères de la clé vous sont réaffichés, la clé n'est jamais incluse dans votre export de données et nous ne l'écrivons pas dans nos journaux. Les enregistrements des requêtes et des appels d'outils suivent la conservation de 90 jours indiquée ci-dessus. Les embeddings utilisent toujours notre propre fournisseur indiqué ci-dessus.

La recherche web et la récupération de pages isolées sont fournies par nos soins, que vous utilisiez ou non votre propre fournisseur d'IA : la requête de recherche formulée par l'assistant (jusqu'à 400 caractères, pouvant être déduite de votre demande ou de votre document) est envoyée à Staan, et l'adresse web que l'assistant souhaite lire est envoyée à Jina AI, directement depuis notre application et via notre compte auprès de ces fournisseurs. Les résultats sont ensuite résumés par votre fournisseur de discussion (le vôtre si vous en avez connecté un, sinon le nôtre). Pour limiter les coûts et les abus, chaque utilisateur ne peut effectuer qu'un nombre limité de recherches web et de récupérations de pages (par défaut 30 par heure et 100 par jour). Nous les comptons dans Valkey sous votre identifiant utilisateur interne ; les compteurs ne contiennent que des horodatages et expirent automatiquement.

Les fonctionnalités d'IA nécessitent un compte et sont facultatives : le contenu d'un document n'est envoyé à un fournisseur d'IA que lorsque vous utilisez l'assistant ou téléversez des fichiers dans une base de connaissances d'espace de travail (ceux-ci sont vectorisés par Jina AI).

## 9. Cookies et technologies similaires

markoto n'utilise **que le stockage strictement nécessaire** à la fourniture du service que vous demandez :

| Nom | Finalité | Durée |
| --- | --- | --- |
| `nuxt-session` | Vous maintient connecté (cookie de session chiffré). Déposé uniquement lorsque vous vous connectez. | 7 jours |
| `ypad_locale` | Mémorise votre langue. | 1 an |
| `markoto-anon-creator` | Clé de créateur aléatoire permettant au navigateur qui a créé un document anonyme de le supprimer. Non liée à vous ; nous n'en conservons qu'une empreinte (hash) avec le document. | 1 an |
| `markoto-anon-terms` | Mémorise que vous avez accepté les conditions d'utilisation avant de créer un document sans compte : la version des conditions et l'heure, signées par nous, sans aucun identifiant. Déposé uniquement lorsque vous acceptez. | 1 an, ou jusqu'à la modification des conditions |
| `nuxt-color-mode` (stockage local) | Mémorise le mode clair ou sombre, si vous en choisissez un. | Jusqu'à ce que vous l'effaciez |
| `markoto:preview-zoom` (stockage local) | Mémorise le niveau de zoom de l'aperçu du document. | Jusqu'à ce que vous l'effaciez |
| `markoto-pending-invite` (stockage de session) | Conserve un lien d'invitation à un espace de travail pendant que vous vous connectez pour l'accepter. | Jusqu'à la fermeture de l'onglet |
| `markoto-anon-avatar` (stockage de session) | Jeton aléatoire qui choisit le visage que voient vos collaborateurs pendant que vous travaillez sur un document sans compte. Il est aussi enregistré avec les modifications et commentaires que vous faites sans compte, afin que le journal d'activité affiche le même visage. Au-delà, non lié à vous ni à votre navigateur. | Dans le navigateur : jusqu'à la fermeture de l'onglet. Avec vos modifications et commentaires : aussi longtemps que le document (point 5) |
| Cache du service worker | Permet à markoto de se charger plus vite et de fonctionner hors ligne. | Jusqu'à ce que vous l'effaciez |

Nous n'utilisons **ni statistiques d'usage, ni enregistrement de sessions, ni publicité, ni pistage intersites**. Tout ce stockage étant strictement nécessaire à un service que vous demandez expressément, il ne requiert aucun consentement au titre de l'article 5, paragraphe 3, de la directive ePrivacy de l'UE et des législations nationales qui la transposent. Au regard du droit suisse (art. 45c LTC), le présent point vous en informe, et vous pouvez à tout moment bloquer ou supprimer les cookies dans votre navigateur ; markoto pourrait alors ne plus vous maintenir connecté ni vous permettre de supprimer des documents anonymes. C'est pourquoi il n'y a pas de bandeau de cookies. Si nous souhaitions un jour utiliser un stockage non essentiel, nous vous demanderions d'abord votre consentement.

Notre ancien bandeau de cookies déposait un cookie `markoto-anon` pour mémoriser votre choix. Nous ne le déposons plus ; il expire de lui-même et vous pouvez le supprimer. Les enregistrements des décisions prises au moyen de ce bandeau sont conservés comme décrit au point 5b.

## 10. Âge minimal

Vous devez avoir au moins **16 ans** pour utiliser markoto, que ce soit avec un compte ou pour des documents anonymes, quel que soit l'âge fixé par le droit de votre pays. Si vous pensez qu'une personne de moins de 16 ans utilise markoto, merci de nous le signaler à **{{privacyContactEmail}}** ; nous supprimerons le compte ou le document.

## 11. Droit d'introduire une réclamation

Si vous estimez que nous n'avons pas respecté vos droits, vous pouvez introduire une réclamation auprès d'une autorité de protection des données.

- **En Suisse :** le Préposé fédéral à la protection des données et à la transparence (PFPDT), www.edoeb.admin.ch.
- **Dans l'UE/EEE :** l'autorité de contrôle du pays dans lequel vous vivez ou travaillez, ou dans lequel la violation alléguée a eu lieu. Le Comité européen de la protection des données en publie la liste. Étant établis en Suisse, nous ne relevons d'aucune autorité chef de file unique au titre du mécanisme de guichet unique du RGPD ; vous pouvez donc vous adresser directement à votre autorité locale.

Nous serions heureux de pouvoir d'abord résoudre votre préoccupation : écrivez-nous à **{{privacyContactEmail}}**.

## 12. Sécurité

Nous protégeons les données par le chiffrement en transit (TLS), le chiffrement au repos assuré par notre fournisseur de stockage, des sauvegardes chiffrées de la base de données, le chiffrement des secrets stockés tels que les clés de fournisseurs d'IA, une séparation stricte de nos services internes, un accès selon le principe du moindre privilège, des adresses IP tronquées dans les journaux et des mises à jour de sécurité régulières. Les comptes markoto n'ont pas de mot de passe propre : vous vous connectez via GitHub ou Google. Si vous protégez un document par un mot de passe, nous n'en conservons qu'une empreinte scrypt. Ces mesures sont décrites plus en détail à l'annexe I de notre accord de traitement des données ([/legal/dpa](/legal/dpa)).

Si une violation de données personnelles est susceptible d'engendrer un risque pour vous, nous en informons l'autorité de contrôle compétente dans un délai de 72 heures lorsque le RGPD l'exige (article 33 du RGPD), et le PFPDT dans les meilleurs délais lorsque la LPD l'exige (art. 24 LPD). Si la violation est susceptible d'engendrer un risque élevé pour vous, nous vous en informons également dans les meilleurs délais.

## 13. Registre des finalités de traitement

Le tableau ci-dessous est généré à partir de notre registre interne des finalités de traitement et ne liste que ce que ce déploiement fait réellement (par exemple, la facturation n'y figure que lorsque les offres payantes sont activées). Le tableau est tenu en anglais.

{{processingPurposesTable}}

## 14. Modifications de la présente politique

Il s'agit de la **version {{currentVersion}}**, en vigueur le **{{effectiveDate}}**. Les modifications substantielles (nouvelles finalités de traitement, nouveaux sous-traitants ultérieurs, conservation modifiée) entraînent un changement de version et une demande d'acceptation de la nouvelle version dans le produit. Les versions précédentes sont disponibles sur demande auprès de **{{privacyContactEmail}}**.

### Historique des modifications

- **v8 (2026-11-03).** Suppression des finalités « statistiques d'usage du produit » et « enregistrement de sessions » ainsi que du bandeau de cookies : ni l'une ni l'autre n'ont jamais été utilisées, et markoto n'utilise que du stockage strictement nécessaire (énuméré au point 9). Ajout de la LPD suisse aux côtés du RGPD, et des pays vers lesquels des données sont transférées (point 4). Description des documents anonymes (acceptation des conditions, vérification anti-robots, suppression après 30 jours au lieu de 180), du noindex sur les documents et des signalements d'abus sans compte, avec accusé de réception, notification de la décision et exposé des motifs (point 2b). Indication de la durée de conservation des sauvegardes (environ 30 jours), des entrées du journal d'audit (2 ans) et des signalements d'abus (1 an après la clôture du dossier). Correction des mentions relatives au hachage des mots de passe, à la règle d'âge (16 ans partout), à la description de l'identification de l'IA et à l'entraînement de l'IA selon chaque fournisseur. Ajout de l'allocation d'IA gratuite pour les utilisateurs connectés (GLM-5.3 Flash de Z.ai, fourni et traité par Mistral AI via son point d'accès européen ; Z.ai ne reçoit aucune donnée), avec sa limite mensuelle par compte et sa réserve mensuelle commune, ainsi que de la conservation des données d'utilisation de l'IA (points 5 et 8). Toutes les requêtes à Mistral AI, y compris la transcription vocale et la dictée en direct, sont envoyées à son point d'accès européen (point 8). Les photos de profil provenant de GitHub, de Google ou de la connexion de votre organisation ne sont plus enregistrées ni affichées : les avatars sont dessinés dans votre navigateur à partir de votre numéro de compte, et les visiteurs sans compte en reçoivent un au hasard (`markoto-anon-avatar`, point 9).
- **v7 (2026-10-27).** Ajout de la finalité de traitement `workspace_invitations` (intérêt légitime) : lorsqu'un administrateur d'espace de travail invite quelqu'un par e-mail, nous conservons cette adresse, le rôle proposé et l'auteur de l'invitation dans une invitation en attente, jusqu'à ce que la personne l'accepte ou la refuse, qu'un administrateur la retire ou qu'elle expire au bout de 14 jours. Personne ne rejoint un espace de travail sans l'avoir accepté. Si l'envoi d'e-mails est configuré, un e-mail d'invitation est envoyé par invitation via Resend (au plus trois par adresse et par jour). Stockage chez OVHcloud (UE).
- **v6 (2026-10-26), alignement rédactionnel sur le service exclusivement gratuit.** Stripe et la facturation sont décrits comme pertinents uniquement lorsque des offres payantes sont proposées (la liste des sous-traitants ultérieurs et le registre omettent Stripe tant que la facturation est désactivée). Le registre des finalités de traitement est désormais réellement affiché au point 13. Correction des mentions relatives à la conservation des journaux d'audit, au nettoyage des documents anonymes (180 jours d'inactivité), au compteur d'interactions supprimé et à la (inexistante) désactivation de l'IA au niveau du compte.
- **v6 (2026-10-26).** Ajout de la finalité de traitement `user_directed_ai_provider` : vous pouvez connecter votre propre fournisseur d'IA (discussion, génération d'images, transcription vocale). Le contenu de ces fonctionnalités est alors envoyé au fournisseur que vous avez choisi, dans le cadre de votre accord avec lui ; nous conservons vos paramètres de fournisseur avec la clé d'API chiffrée au repos jusqu'à ce que vous les supprimiez ou supprimiez votre compte. La recherche web et la récupération de pages sont fournies par nos soins à tous les utilisateurs, y compris ceux qui ont leur propre fournisseur d'IA : les requêtes de recherche vont à Staan et les adresses web récupérées à Jina AI ; des compteurs d'utilisation horaires et quotidiens par personne (horodatages uniquement, sans contenu) sont conservés dans Valkey.
- **v5 (2026-10-26).** Ajout de la finalité de traitement `paid_plans_waitlist` (consentement, double opt-in) : adresse e-mail, langue, preuve de consentement et lien facultatif avec le compte, conservés jusqu'à la désinscription ou, au plus tard, 3 mois après l'annonce du lancement des offres payantes ; inscriptions non confirmées supprimées après 7 jours. Stockage chez OVHcloud (UE) ; e-mails de confirmation via Resend.
- **v2 (2026-05-05).** Ajout de Resend, Inc. comme sous-traitant ultérieur pour l'envoi des e-mails transactionnels (confirmations de suppression, notifications d'export de données prêt). Les métadonnées des e-mails sont conservées 30 jours par Resend ; le contenu n'est pas archivé. La finalité `transactional_email` référence désormais Resend dans le registre des bases juridiques.
- **v1 (2026-05-04).** Publication initiale.
