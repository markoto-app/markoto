---
title: Convertir Markdown en PDF, avec de vraies pages
description: Collez votre Markdown, voyez-le en pages A4 ou Letter et téléchargez le PDF. En-têtes, pieds de page, numéros de page, couverture, table des matières, formules.
keywords:
  - markdown en pdf
  - convertir markdown en pdf
  - convertir markdown en pdf en ligne
  - md en pdf
  - export pdf markdown avec numéros de page
  - markdown en pdf avec table des matières
# Menu label once reviewed (group + order come from the English page).
navLabel: "Markdown en PDF"
updated: '2026-11-08'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Convertir Markdown en PDF, avec de vraies pages

Collez votre Markdown dans le cadre ci-dessous. L'aperçu le met en pages au fil de la frappe, avec un en-tête courant et des numéros de page. Quand le résultat vous convient, cliquez sur **Télécharger le PDF** : le fichier contient exactement les pages de l'aperçu.

::try-it{theme="modern" height="600"}
---
source: |
  # Rapport de projet

  [[toc]]

  ## Synthèse

  Collez ici votre propre Markdown. L'aperçu l'affiche en pages A4, et **Télécharger le PDF** vous donne les mêmes pages dans un fichier.

  ## Résultats

  | Trimestre | Commandes | Évolution |
  |:----------|----------:|----------:|
  | T1        |      1240 |         – |
  | T2        |      1610 |      +30% |

  Le taux de croissance est $g = \frac{1610 - 1240}{1240} \approx 0.30$.[^1]

  > [!NOTE]
  > L'en-tête affiche le titre, le pied de page la page *n* sur *total*.

  <!-- pagebreak -->

  ## Prochaines étapes

  - [x] Rédiger le brouillon
  - [ ] Choisir un thème
  - [ ] Envoyer le PDF

  [^1]: Les notes se placent en bas de la page à laquelle elles appartiennent.
---
::

Le PDF est produit sur notre serveur à partir d'un document enregistré : **Télécharger le PDF** enregistre donc d'abord votre texte comme document. Tant que vous tapez seulement dans le cadre, rien n'est enregistré.

## Ce que contient le PDF

Un convertisseur transforme le Markdown en une seule longue page HTML et l'imprime. markoto met d'abord le texte en pages, pour que vous voyiez et décidiez où chaque élément tombe :

- **Format de page et marges.** A4, Letter ou Legal, en portrait ou en paysage, avec les marges de votre choix.
- **En-têtes et pieds de page.** Des zones à gauche, au centre et à droite pour le titre du document, le numéro de page, le nombre de pages et la date, plus un logo si vous le souhaitez.
- **Une page de couverture.** Quatre mises en page avec titre, sous-titre, auteurs, date et logo. La couverture n'a ni en-tête ni numéro de page.
- **Une table des matières avec numéros de page.** Écrivez `[[toc]]` à l'endroit voulu.
- **Les notes en bas de page**, et non regroupées à la fin.
- **Des sauts de page** là où vous placez `<!-- pagebreak -->` sur une ligne seule.
- **Formules, diagrammes et code.** Les formules LaTeX (KaTeX), les diagrammes Mermaid, le code avec coloration syntaxique, les tableaux et les encarts de style GitHub s'affichent sur la page.

::flow-strip{id="polished-pdf" frames="07" caption="Un PDF téléchargé : la page de couverture et la première page de contenu, telles qu'elles apparaissaient dans l'aperçu."}
::

## Changer l'apparence sans toucher au texte

Chaque document a un thème : polices, couleurs, marges, colonnes, tableaux, en-tête, pied de page et couverture. Les modèles inclus comprennent markoto, Moderne, Prépublication arXiv, Article de conférence IEEE (deux colonnes), Thèse, Documentation technique, Rapport d'entreprise, Newsletter et CV. Choisissez-en un, puis modifiez n'importe quel détail. L'aperçu et le PDF utilisent le même thème. Si aucun réglage ne fait ce que vous voulez, vous pouvez ajouter votre propre [CSS](/docs/themes/custom-css) à un document.

::flow-strip{id="pick-a-theme" frames="05,14"}
---
captions:
  - Le modèle Prépublication arXiv compose le texte en Times, justifié, numérote les sections et place le titre dans un bloc en haut de la page 1.
  - Le modèle markoto avec sa page de couverture, qui porte le logo, le titre et la date, mais pas de numéro de page.
---
::

Pour aller plus loin, dans la documentation (en anglais) : [choisir un thème](/docs/themes/pick-a-theme), [modifier la page de couverture](/docs/themes/cover-page), [polices, couleurs et mise en page](/docs/themes/customize).

## Vous avez déjà un fichier .md ?

Créez un document, choisissez **Fichier › Importer**, puis le fichier. Les fichiers Markdown jusqu'à 10 Mo sont chargés tels quels. Les fichiers Word (.docx), PDF, PowerPoint, Excel, HTML et EPUB jusqu'à 50 Mo sont d'abord convertis en Markdown. Exportez ensuite avec **Fichier › Exporter › PDF**.

::flow-strip{id="import-existing-document" frames="11" caption="Un fichier importé dans l'éditeur, avec l'aperçu paginé à côté."}
::

## Limites

- **Le PDF est produit sur le serveur.** Un nouveau PDF prend quelques secondes ; le redemander sans modification est instantané. Vous pouvez exporter jusqu'à 10 PDF par minute depuis un même réseau. `Cmd/Ctrl + P` imprime les mêmes pages par votre navigateur.
- **Le HTML brut n'est pas interprété.** Les balises HTML du Markdown s'affichent comme du texte. Utilisez plutôt la syntaxe Markdown ou le thème.
- **Trois formats de page.** A4, Letter et Legal. Il n'y a pas de format personnalisé.
- **Les images demandent un compte.** Sans compte, vous ne pouvez pas importer d'images dans un document.
- **Un document à la fois.** La page n'a pas de conversion par lots. Pour exporter de nombreux documents depuis un script, utilisez le [serveur MCP](/docs/ai/mcp) avec un compte.

Pour les articles scientifiques, voyez comment markoto se compare à [Overleaf](/compare/overleaf) (en anglais). Les prix et les limites figurent sur la [page des tarifs](/pricing).

## Questions

::faq{json-ld}
---
items:
  - q: La conversion de Markdown en PDF est-elle gratuite ?
    a: Oui. Sur markoto.app, vous pouvez écrire, prévisualiser et télécharger des PDF sans compte et sans payer.
  - q: Faut-il s'inscrire ?
    a: Non. Sans compte, le PDF est produit à partir d'un document anonyme que toute personne disposant du lien peut modifier, et qui est supprimé après 30 jours sans modification. Avec un compte gratuit, le document vous appartient et reste privé.
  - q: Le PDF peut-il avoir des numéros de page et une table des matières ?
    a: Oui. Le pied de page ou l'en-tête peut afficher le numéro de page et le nombre de pages, et la table des matières écrite avec [[toc]] indique la page de chaque titre.
  - q: Le PDF ressemble-t-il à l'aperçu ?
    a: Oui. L'aperçu et le PDF sont produits à partir de la même mise en page et du même thème : les pages se coupent aux mêmes endroits.
  - q: Quel Markdown est pris en charge ?
    a: CommonMark et GitHub Markdown (tableaux, listes de tâches, texte barré, notes de bas de page, encarts), plus les formules LaTeX, les diagrammes Mermaid et quelques extensions comme le surlignage et les listes de définitions. L'aide-mémoire Markdown les présente toutes.
  - q: Puis-je utiliser le format Letter au lieu de l'A4 ?
    a: Oui. Chaque thème définit le format de page ; A4, Letter et Legal sont disponibles, en portrait ou en paysage.
---
::

::cta{title="Transformez votre Markdown en PDF." secondary-label="Lire le guide PDF" secondary-to="/docs/import-export/polished-pdf"}
Créez un document, collez votre texte et téléchargez le PDF quand les pages vous conviennent. Sans inscription.
::
