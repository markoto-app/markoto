---
slug: privacy
locale: fr
version: 6
effectiveDate: 2026-10-26
translationStatus: machine-translated
---

# Politique de confidentialité

> **En bref :** markoto conserve les documents que vous rédigez, les commentaires que vous laissez et le minimum nécessaire pour gérer votre compte. Le service est actuellement gratuit ; les offres payantes ne sont pas encore proposées. Les fonctionnalités d'IA reposent sur des fournisseurs établis dans l'UE (Mistral AI pour le texte et la voix, Jina AI pour les embeddings et la récupération de pages isolées, Staan pour la recherche web, Black Forest Labs pour la génération d'images), sauf si vous connectez votre propre fournisseur d'IA : dans ce cas, votre contenu d'IA est envoyé au fournisseur que vous avez choisi. Nous ne vendons pas vos données, nous n'affichons pas de publicité et nous n'entraînons pas d'IA sur votre contenu. Vous pouvez exporter les données que nous détenons sur vous et supprimer votre compte à tout moment depuis vos paramètres.

---

## 1. Qui nous sommes

markoto est exploité par **{{controllerName}}** ({{controllerAddress}}). Pour toute question relative à la vie privée, écrivez à **{{privacyContactEmail}}**.

Au sens du règlement général sur la protection des données (règlement (UE) 2016/679 — « RGPD »), markoto est le **responsable du traitement** des données à caractère personnel que vous nous fournissez directement (votre compte et, si vous vous y inscrivez, la liste d'attente des offres payantes). Lorsque vous utilisez markoto dans un espace de travail appartenant à un tiers, le propriétaire de cet espace est le responsable du traitement de tout contenu que vous y placez, et markoto agit en tant que **sous-traitant** dans le cadre d'un accord de traitement des données (voir `/legal/dpa`).

## 2. Quelles données nous traitons et pourquoi

Nous appliquons le principe de minimisation des données : nous ne collectons que le minimum nécessaire pour chaque finalité, et nous vous indiquons quelle est cette finalité.

Le tableau complet des finalités de traitement — avec la base juridique, les catégories de données, la durée de conservation et les sous-traitants ultérieurs concernés — figure dans le registre du point 13 ci-dessous, généré à partir de notre registre interne. Toute modification de ce registre est considérée comme une modification substantielle de la présente politique et fait évoluer le numéro de version (voir le point 14).

## 3. Base juridique (article 6 du RGPD)

Chaque traitement repose sur l'une des bases juridiques suivantes :

- **Contrat** (article 6, paragraphe 1, point b) — pour tout ce qui est nécessaire à la fourniture du service auquel vous vous êtes inscrit : création de compte, stockage des documents, assistance de l'IA et, dès que des offres payantes sont proposées, facturation.
- **Obligation légale** (article 6, paragraphe 1, point c) — pour la journalisation d'audit de sécurité et, dès que des offres payantes sont proposées, les obligations de conservation du droit fiscal (données de facturation).
- **Intérêt légitime** (article 6, paragraphe 1, point f) — pour la prévention de la fraude et des abus, la surveillance des erreurs et la télémétrie de sécurité. Vous pouvez vous opposer au traitement fondé sur cette base (voir le point 6).
- **Consentement** (article 6, paragraphe 1, point a) — pour les statistiques d'usage et l'enregistrement de sessions (nous ne les chargeons jamais sans votre consentement donné dans le bandeau de cookies) ainsi que pour la liste d'attente des offres payantes (uniquement si vous cochez la case de consentement lors de l'inscription puis confirmez l'e-mail que nous vous envoyons). Vous pouvez retirer votre consentement à tout moment.

## 4. Sous-traitants ultérieurs et transferts internationaux

Nous faisons appel à une courte liste de sous-traitants ultérieurs, tous liés par des contrats conformes à l'article 28 du RGPD. La liste à jour figure à l'adresse `/legal/sub-processors`. Cette liste n'indique que les prestataires réellement utilisés par ce déploiement : par exemple, Stripe (paiement) n'y apparaît que lorsque les offres payantes sont activées, et un fournisseur d'IA que **vous** connectez vous-même (voir le point 8) n'est pas notre sous-traitant ultérieur et n'y figure pas.

Lorsqu'un sous-traitant ultérieur traite des données en dehors de l'Espace économique européen, nous nous appuyons sur :

- la décision d'adéquation relative au **cadre de protection des données UE-États-Unis** (Data Privacy Framework, 10 juillet 2023) pour les destinataires établis aux États-Unis et certifiés DPF, ET
- les **clauses contractuelles types** (2021/914) à titre subsidiaire, au cas où la décision d'adéquation relative au DPF serait invalidée.

Nous informons les clients propriétaires d'espaces de travail au moins 30 jours à l'avance de tout nouveau sous-traitant ultérieur.

## 5. Lieu de stockage et conservation

Les données de l'application et les documents sont hébergés dans la base PostgreSQL gérée et le stockage d'objets d'OVHcloud, dans l'Union européenne (France). Le traitement lié à l'IA est effectué par des fournisseurs établis dans l'UE — Mistral AI (France), Jina AI (Allemagne), Staan (UE) et Black Forest Labs (région UE dédiée) — via notre proxy LiteLLM auto-hébergé. Tant que le service est gratuit, nous ne traitons aucune donnée de paiement ; dès que des offres payantes sont proposées, les données de facturation seront détenues par Stripe. La télémétrie d'erreurs de l'application est traitée par Sentry dans sa région UE (Francfort). Les e-mails transactionnels (confirmations de suppression, notifications d'export de données prêt, notifications de violation) sont envoyés via Resend ; seuls l'adresse du destinataire, l'objet et le corps du message transitent par les systèmes de Resend, qui les conserve 30 jours pour surveiller la délivrabilité.

La conservation suit le calendrier par finalité figurant dans le registre du point 13. En règle générale :

- **Les données de compte** sont conservées jusqu'à ce que vous demandiez la suppression.
- **Les documents et contenus** sont conservés jusqu'à ce que vous les supprimiez ou supprimiez votre compte.
- **Les documents anonymes** (créés sans connexion et ne faisant pas partie d'un espace de travail) sont supprimés automatiquement après 180 jours sans activité sur le service hébergé. Les déploiements auto-hébergés peuvent configurer une autre durée ou désactiver ce nettoyage. Les documents appartenant à un compte et les documents d'espace de travail ne sont pas supprimés automatiquement.
- **Les enregistrements des requêtes à l'IA et des appels d'outils** sont conservés 90 jours pour l'examen des abus, puis purgés.
- **Les journaux d'audit** sont conservés aussi longtemps que nécessaire à des fins de sécurité et juridiques. Lorsque vous supprimez votre compte, votre identifiant de compte en est retiré (voir le point 5b).
- **Les données de facturation** n'existent pas tant que le service est gratuit. Dès que des offres payantes sont proposées, elles seront conservées pendant la durée minimale imposée par le droit fiscal de l'UE et des États membres (généralement 7 à 10 ans).
- **Les métadonnées des e-mails transactionnels** (destinataire, horodatage d'envoi, statut de livraison) sont conservées 30 jours par Resend ; nous ne conservons pas le corps des e-mails après leur livraison.
- **Liste d'attente des offres payantes.** Si vous vous inscrivez sur la liste d'attente depuis la page des tarifs, nous conservons votre adresse e-mail, la langue utilisée lors de l'inscription, la version du texte de consentement que vous avez acceptée, la date de l'inscription et de la confirmation et, si vous étiez connecté, un lien vers votre compte. Nous ne conservons pas votre adresse IP. Nous l'utilisons uniquement pour vous informer du lancement des offres payantes. Votre inscription n'est prise en compte qu'après un clic sur le lien de confirmation envoyé par e-mail (double opt-in) ; les inscriptions non confirmées sont supprimées après 7 jours. Chaque e-mail contient un lien de désinscription qui supprime immédiatement votre inscription ; à défaut, nous supprimons la liste au plus tard 3 mois après l'envoi de l'annonce du lancement. La suppression de votre compte supprime également une inscription liée, et votre export de données l'inclut. L'e-mail de confirmation est envoyé via Resend ; la liste elle-même est stockée dans la base PostgreSQL gérée d'OVHcloud, dans l'UE.

## 5b. Ce qui se passe lorsque vous supprimez votre compte

Nous souhaitons être totalement transparents sur les effets de la suppression. Le bouton disponible à l'adresse `/settings/profile` programme la suppression définitive de votre compte **dans 30 jours**. Pendant ce délai de grâce, votre compte reste utilisable ; vous pouvez annuler depuis toute page affichant le bandeau de suppression. Une fois les 30 jours écoulés, ce qui suit s'exécute automatiquement — sans nouvelle confirmation et sans possibilité de rien récupérer.

### Ce qui est supprimé définitivement

- **Votre enregistrement de compte** — nom, e-mail, identifiants OAuth, préférences, langue, confirmation d'âge, versions des politiques acceptées.
- **Chaque document dont vous êtes propriétaire** — y compris les documents partagés avec des collaborateurs en mode édition. Les collaborateurs perdent en même temps l'accès à ces documents. *Si vous souhaitez que des collaborateurs conservent un document, transférez-leur-le ou dupliquez-le sous leur compte avant de demander la suppression.*
- **Chaque thème enregistré** sous votre compte.
- **Chaque espace de travail dont vous êtes le seul membre** — ainsi que chaque document et fichier de connaissances qu'il contient. *Si vous souhaitez conserver le contenu d'un espace de travail, invitez d'abord un autre membre avant de supprimer votre compte, ou téléchargez les documents au préalable avec la fonction d'export de données à l'adresse `/settings/profile`.*
- **Votre utilisation de l'IA** — requêtes passées (nous les conservons de manière privée 90 jours pour l'examen des abus), sessions d'IA ouvertes et paramètres d'un fournisseur d'IA personnel (apportez votre propre clé) avec leurs clés d'API chiffrées (voir le point 8).
- **Vos tâches d'export de données** et les fichiers ZIP que nous avions préparés pour vous.
- **Votre fiche client Stripe, le cas échéant** (possible uniquement lorsque des offres payantes sont proposées) — nous demandons à Stripe de la supprimer. Stripe conserve les factures et enregistrements de paiement sous-jacents pendant la durée exigée par le droit fiscal (généralement 7 à 10 ans), quelle que soit notre demande.

### Ce qui est anonymisé — conservé sur la plateforme sans votre nom

- **Les commentaires que vous avez rédigés sur des documents dont vous n'êtes pas propriétaire** — le texte reste pour que la conversation demeure intelligible pour les autres participants, mais votre nom et le lien avec votre compte sont remplacés par `[utilisateur supprimé]`.
- **Les entrées du journal d'audit** — nous conservons notre journal de sécurité interne sans votre identifiant de compte, mais avec l'action correspondante. Base juridique : intérêt légitime à prévenir la fraude + obligation légale. La conservation suit notre politique habituelle de journal d'audit.
- **Les entrées du journal d'activité** — vos modifications, restaurations et changements de thème sur des documents dont vous n'êtes PAS propriétaire restent dans le fil d'activité du document sous « Anonyme ». Les modifications sur vos propres documents disparaissent avec le document.
- **Les entrées du journal de consentement** — nous anonymisons le lien avec l'utilisateur mais conservons l'enregistrement historique afin de pouvoir démontrer que le consentement a été donné (exigence de l'article 7, paragraphe 1, du RGPD).

### Ce qu'il advient des espaces de travail dont vous êtes administrateur avec d'autres personnes

Si vous êtes administrateur d'un espace de travail comptant au moins un autre membre lors de la suppression de votre compte, **nous promouvons automatiquement l'un des membres restants au rang d'administrateur** — le membre le plus ancien, en privilégiant un administrateur existant, puis un éditeur existant, puis un lecteur. L'espace de travail et son contenu sont conservés pour les membres restants. Le nouvel administrateur est informé après la promotion.

Le champ de provenance « propriétaire » de l'espace de travail est réattribué au nouvel administrateur afin que les clés étrangères restent cohérentes. Les autorisations ont toujours reposé sur le rôle de membre et non sur le champ propriétaire ; il s'agit donc d'une simple écriture comptable.

### Espaces de travail à nettoyer manuellement au préalable

Parce que la suppression en cascade d'un espace de travail supprime aussi du contenu appartenant à d'autres membres lorsque vous en étiez la seule personne, nous vous recommandons vivement de procéder comme suit avant de demander la suppression de votre compte si vous voulez préserver le travail d'autrui :

- Pour tout espace de travail dont vous êtes le seul membre mais dont vous souhaitez conserver le contenu : invitez d'abord au moins un collaborateur avec le rôle d'administrateur, qui en héritera.
- Pour tout document que vous souhaitez voir conservé par un collaborateur : transférez-en la propriété (déplacez-le hors de votre espace de travail vers un espace qui lui appartient, OU dupliquez-le sous son compte) ou demandez-lui d'en télécharger une copie au préalable.
- Pour les fichiers de la base de connaissances que vous souhaitez préserver : téléchargez-les en dehors de markoto, car ils sont supprimés avec l'espace de travail.

### Votre export de données

Avant de demander la suppression de votre compte, vous pouvez utiliser la fonction **export de données** à l'adresse `/settings/profile` pour recevoir une archive ZIP de tout ce que nous détenons sur vous — documents en markdown, commentaires que vous avez rédigés, appartenances aux espaces de travail, journaux d'utilisation de l'IA, vos paramètres de fournisseur d'IA (URL du fournisseur, modèle et fonctionnalité — jamais la clé d'API), votre inscription sur la liste d'attente le cas échéant, vos décisions de consentement et, dès que des offres payantes existent, l'historique de facturation. Il s'agit d'un processus distinct qui produit un fichier téléchargeable que vous pouvez conserver quel que soit le sort de votre compte markoto.

### Combien de temps dure réellement la cascade

Une tâche en arrière-plan exécute la cascade une fois par heure. Au pire, vos données sont entièrement purgées environ une heure après la fin du délai de grâce de 30 jours. Vous recevrez un e-mail de confirmation lorsque la suppression aura été exécutée (sous réserve qu'une adresse e-mail soit enregistrée).

### Annulation

Tant que la cascade n'a pas été exécutée, vous pouvez annuler la suppression programmée en vous connectant et en cliquant sur « Annuler la suppression » depuis n'importe quelle page (un bandeau apparaît en haut de l'écran pendant le délai de grâce). Après l'exécution de la cascade, votre compte, vos sessions et vos contenus ont disparu — il n'existe aucun moyen de les récupérer.

## 6. Vos droits (articles 15 à 22 du RGPD)

Vous avez le droit :

- d'**accéder** aux données à caractère personnel que nous détenons à votre sujet (article 15) — utilisez l'outil d'export à l'adresse `/settings/profile` ;
- de **rectifier** les données inexactes (article 16) — modifiez votre profil ou écrivez-nous ;
- d'**effacer** vos données (« droit à l'oubli », article 17) — utilisez l'outil de suppression à l'adresse `/settings/profile`. Nous attendons 30 jours puis purgeons définitivement ;
- de **limiter** le traitement (article 18) — écrivez-nous ;
- de vous **opposer** au traitement fondé sur l'intérêt légitime (article 21) — écrivez-nous ;
- à la **portabilité des données** (article 20) — l'outil d'export fournit vos données en JSON, NDJSON et Markdown lisibles par machine ;
- de **retirer votre consentement** (article 7, paragraphe 3) lorsque le traitement repose sur le consentement — activez ou désactivez la finalité concernée dans le bandeau de cookies (icône de confidentialité en pied de page) ;
- d'**introduire une réclamation** auprès d'une autorité de contrôle (article 77) — voir le point 11.

Nous répondons à toutes les demandes dans un délai de 30 jours. Nous ne facturons pas ces demandes, sauf en cas de demandes manifestement infondées ou excessives.

## 7. Décision automatisée

markoto ne prend aucune décision produisant des effets juridiques ou vous affectant de manière significative de façon similaire sur le seul fondement d'un traitement automatisé. L'assistant IA propose des suggestions que vous choisissez d'accepter ou de rejeter — la paternité finale vous revient toujours. Dès que des offres payantes seront proposées, Stripe effectuera une évaluation automatisée du risque sur les tentatives de paiement ; si une tentative est refusée sur cette base, vous pourrez demander un examen humain en nous écrivant.

## 8. Fonctionnalités d'IA et transparence

markoto comprend un assistant d'écriture IA et un système de recherche dans la base de connaissances. Les requêtes d'IA sont acheminées via notre proxy LiteLLM auto-hébergé vers des fournisseurs établis dans l'UE : Mistral AI (génération de texte, transcription vocale via Voxtral), Jina AI (embeddings pour la base de connaissances, extraction du contenu d'une URL isolée), Staan (recherche web via un index de recherche européen propriétaire, acheminement exclusivement dans l'UE) et Black Forest Labs (génération d'images, région UE dédiée). Les requêtes de recherche web ne transitent plus par des moteurs de recherche américains. Nous le signalons dans l'interface : chaque message assisté par l'IA porte un badge « IA » visible, et tout contenu généré par l'IA placé dans un document public est accompagné d'une mention de transparence. Aucun de ces fournisseurs n'utilise le contenu de l'API pour entraîner ses modèles dans les offres que nous utilisons.

### Votre propre fournisseur d'IA (apportez votre propre clé)

Vous pouvez connecter votre propre compte de fournisseur d'IA (un service compatible OpenAI parmi les choix proposés dans les paramètres, par exemple Mistral AI ou OpenAI ; les déploiements auto-hébergés de markoto peuvent en autoriser d'autres) sous **Paramètres → Fournisseur d'IA**, séparément pour la discussion, la génération d'images et la transcription vocale. Dans ce cas, le contenu nécessaire à cette fonctionnalité — votre requête, le contexte pertinent du document, les enregistrements vocaux et le résultat généré — est envoyé via notre proxy LiteLLM à **le fournisseur que vous avez choisi, dans le cadre de votre propre accord avec ce fournisseur**. markoto ne choisit pas ce fournisseur, et celui-ci n'est pas l'un de nos sous-traitants ultérieurs ; ses conditions et ses pratiques de protection des données (y compris le lieu de traitement et l'éventuel entraînement sur le contenu de l'API) sont celles de votre contrat avec lui. Nous conservons vos paramètres de fournisseur (URL du fournisseur, nom du modèle et votre clé d'API, chiffrée au repos) jusqu'à ce que vous les supprimiez ou supprimiez votre compte ; seuls les quatre derniers caractères de la clé vous sont réaffichés, la clé n'est jamais incluse dans votre export de données (l'export contient uniquement l'URL du fournisseur, le modèle et la fonctionnalité) et nous ne l'écrivons pas dans les journaux de notre application. Les enregistrements des requêtes et des appels d'outils suivent la conservation de 90 jours indiquée ci-dessus. Les embeddings utilisent toujours notre propre fournisseur établi dans l'UE énuméré ci-dessus.

La recherche web et la récupération de pages isolées sont fournies par nos soins et fonctionnent de la même manière que vous utilisiez ou non votre propre fournisseur d'IA : la requête de recherche formulée par l'assistant (jusqu'à 400 caractères, pouvant être déduite de votre demande ou de votre document) est envoyée à Staan, et l'adresse web que l'assistant souhaite lire est envoyée à Jina AI (Jina Reader), dans les deux cas directement depuis notre application (sans passer par le proxy LiteLLM) et via notre propre compte auprès de ce fournisseur, et non le vôtre. Staan et Jina AI sont nos sous-traitants, énumérés ci-dessus. Les résultats de recherche ou le texte extrait de la page sont ensuite résumés par votre fournisseur de discussion (votre propre fournisseur si vous en avez connecté un, sinon le nôtre) : ce texte lui est donc transmis. Pour limiter les coûts et les abus, chaque personne connectée ne peut effectuer qu'un nombre limité de recherches web et de récupérations de pages par heure et par jour (par défaut 30 par heure et 100 par jour, partagées entre l'éditeur et les clients MCP). Pour l'appliquer, nous conservons dans Valkey des compteurs associés à votre identifiant utilisateur interne, qui ne contiennent que des horodatages — ni requête, ni adresse, ni contenu — et expirent automatiquement à la fin de leur fenêtre de temps. Ces outils ne sont disponibles que si l'exploitant les a configurés.

L'utilisation des fonctionnalités d'IA nécessite d'être connecté. Elles sont facultatives : le contenu d'un document n'est envoyé à un fournisseur d'IA que lorsque vous faites appel à l'assistant ou téléversez des fichiers dans une base de connaissances d'espace de travail (ceux-ci sont vectorisés par Jina AI).

## 9. Cookies et technologies similaires

Nous utilisons un stockage essentiel (un cookie de session, une préférence de langue et votre décision de consentement elle-même) pour vous maintenir connecté et mémoriser vos préférences — cela ne requiert pas de consentement au titre de la directive ePrivacy. Nous n'utilisons les statistiques d'usage et l'enregistrement de sessions qu'avec votre consentement, que vous pouvez accorder ou retirer à tout moment depuis le lien « Choix de confidentialité » en pied de chaque page.

Nous n'utilisons pas de traceurs publicitaires intersites et nous ne vendons ni ne partageons de données avec des annonceurs.

## 10. Enfants

markoto ne s'adresse pas aux enfants n'ayant pas atteint l'âge du consentement numérique dans votre pays (16 ans dans la plupart des États membres de l'UE ; moins dans certains). Si vous apprenez qu'un enfant a créé un compte en violation de cette règle, merci de le signaler à **{{privacyContactEmail}}**.

## 11. Droit d'introduire une réclamation

Si vous estimez que nous n'avons pas respecté vos droits, vous avez le droit d'introduire une réclamation auprès d'une autorité de contrôle de la protection des données.

- **Dans l'UE/EEE :** vous pouvez saisir l'autorité de contrôle de votre pays de résidence habituelle, de votre lieu de travail ou du lieu de la violation alléguée. Une liste des autorités de contrôle de l'UE/EEE est publiée par le Comité européen de la protection des données. Étant établis en Suisse (hors UE/EEE), nous ne relevons pas du mécanisme de « guichet unique » du RGPD ; il n'existe donc pas d'autorité chef de file unique — vous pouvez vous adresser directement à votre autorité locale.
- **En Suisse :** l'autorité compétente est le Préposé fédéral à la protection des données et à la transparence (PFPDT).

Nous serions également heureux de pouvoir d'abord résoudre directement votre préoccupation — écrivez-nous à **{{privacyContactEmail}}**.

## 12. Sécurité

Nous protégeons les données par le chiffrement du transport (TLS), le chiffrement au repos au niveau de la plateforme OVHcloud, le hachage des mots de passe avec scrypt et la troncature des adresses IP dans les journaux d'audit. En cas de violation de données à caractère personnel, nous nous engageons à en informer l'autorité de contrôle compétente dans un délai de 72 heures, conformément à l'article 33 du RGPD.

Si nous avons connaissance d'une violation de données à caractère personnel vous concernant, nous en informerons l'autorité de contrôle dans un délai de 72 heures et vous en informerons dans les meilleurs délais si la violation présente un risque élevé pour vos droits.

## 13. Registre des finalités de traitement

Le tableau ci-dessous est généré à partir de notre registre interne des finalités de traitement et ne liste que ce que ce déploiement fait réellement (par exemple, la facturation n'y figure que lorsque les offres payantes sont activées). Le tableau est tenu en anglais.

{{processingPurposesTable}}

## 14. Modifications de la présente politique

Il s'agit de la **version {{currentVersion}}**, en vigueur le **{{effectiveDate}}**. Les modifications substantielles (nouvelles finalités de traitement, nouveaux sous-traitants ultérieurs, conservation modifiée) entraînent un changement de version et une demande de nouvelle acceptation dans le produit. Les versions précédentes sont disponibles sur demande auprès de **{{privacyContactEmail}}**.

### Historique des modifications

- **v6 (2026-10-26), alignement rédactionnel sur le service exclusivement gratuit.** Stripe et la facturation sont décrits comme pertinents uniquement lorsque des offres payantes sont proposées (la liste des sous-traitants ultérieurs et le registre omettent Stripe tant que la facturation est désactivée). Le registre des finalités de traitement est désormais réellement affiché au point 13. Correction des mentions relatives à la conservation des journaux d'audit, au nettoyage des documents anonymes (180 jours d'inactivité), au compteur d'interactions supprimé et à la (inexistante) désactivation de l'IA au niveau du compte.
- **v6 (2026-10-26).** Ajout de la finalité de traitement `user_directed_ai_provider` : vous pouvez connecter votre propre fournisseur d'IA (discussion, génération d'images, transcription vocale). Le contenu de ces fonctionnalités est alors envoyé au fournisseur que vous avez choisi, dans le cadre de votre accord avec lui ; nous conservons vos paramètres de fournisseur avec la clé d'API chiffrée au repos jusqu'à ce que vous les supprimiez ou supprimiez votre compte. La recherche web et la récupération de pages sont fournies par nos soins à tous les utilisateurs, y compris ceux qui ont leur propre fournisseur d'IA : les requêtes de recherche vont à Staan et les adresses web récupérées à Jina AI ; des compteurs d'utilisation horaires et quotidiens par personne (horodatages uniquement, sans contenu) sont conservés dans Valkey.
- **v5 (2026-10-26).** Ajout de la finalité de traitement `paid_plans_waitlist` (consentement, double opt-in) : adresse e-mail, langue, preuve de consentement et lien facultatif avec le compte, conservés jusqu'à la désinscription ou, au plus tard, 3 mois après l'annonce du lancement des offres payantes ; inscriptions non confirmées supprimées après 7 jours. Stockage chez OVHcloud (UE) ; e-mails de confirmation via Resend.
- **v2 (2026-05-05).** Ajout de Resend, Inc. comme sous-traitant ultérieur pour l'envoi des e-mails transactionnels (confirmations de suppression, notifications d'export de données prêt). Les métadonnées des e-mails sont conservées 30 jours par Resend ; le contenu n'est pas archivé. La finalité `transactional_email` référence désormais Resend dans le registre des bases juridiques.
- **v1 (2026-05-04).** Publication initiale.
