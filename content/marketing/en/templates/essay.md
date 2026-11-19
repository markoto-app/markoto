---
title: APA essay template in Markdown with PDF export
description: An APA 7 student paper template in Markdown with title page, thesis statement, headings, block quotations and a double-spaced reference list, as a PDF.
keywords:
  - apa essay template
  - apa 7 student paper template
  - essay template markdown
  - apa title page template
  - write an essay in markdown
updated: '2026-11-19'
navGroup: templates
navLabel: APA essay template
navOrder: 80
---

# APA essay template in Markdown

An essay for a course often has to follow APA 7: a title page with your name, department, course and instructor, double-spaced text, headings in a set style and a reference list with a hanging indent. This template sets all of that for you, so you can spend the time on the argument.

Below is the start of an essay written with the **APA essay** theme. The title page comes from the document title and the cover fields; the text starts right below it.

::try-it{theme="essay" height="760"}
---
source: |
  # Do Printed Books Still Teach Better?

  Many studies report that people understand printed text better than text on a screen (Clinton, 2019). Few of them ask whether the difference survives once readers are used to tablets. This essay argues that the medium matters less than the reading habits that come with it.

  # Evidence From Experiments

  Delgado et al. (2018) pooled 54 studies and found a small advantage for paper that grew with the length of the text.[^1] The advantage disappeared when readers could take notes on screen.

  > Screens are not worse because they are screens. They are worse because we skim on them.
  > (Hypothetical author, 2020, p. 12)

  # Counterarguments

  The strongest objection is that skimming is not a habit but a response to the interface. If that is true, a better interface should close the gap.

  # Conclusion

  The medium shapes how we read, but readers can change how they use it.

  # References

  Clinton, V. (2019). Reading from paper compared to screens. *Journal of Research in Reading*, *42*(2), 288-325.

  Delgado, P., Vargas, C., Ackerman, R., & Salmeron, L. (2018). Don't throw away your printed books. *Educational Research Review*, *25*, 23-38.

  [^1]: The effect size was d = 0.21.
---
::

::page-shots{caption="The first page of the APA essay template: the title page with name, department, course and instructor."}
---
pages:
  - src: /template-thumbs/essay.webp
    alt: APA title page with the paper title, an author name, a university department, a course and an instructor.
---
::

::cta{title="Start your essay from this template." label="Use this template" template="essay" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the APA essay template selected: the text and the APA essay theme in one. Each section starts with a short brief.
::

## What's in it

- **Title page.** The title, your name, and in the affiliation field the department and university, the course number and name, and the instructor, one per line. The date comes from the cover. The title repeats at the top of page 2, so the introduction needs no heading.
- **Introduction with a thesis statement.** The brief asks for one sentence that takes a position someone could disagree with.
- **Main points.** One heading per argument: a claim, evidence with citations, and how the evidence supports the claim.
- **Counterarguments.** The strongest objection, stated fairly, and your answer.
- **Conclusion and references.** The reference list starts on a new page, double-spaced with a hanging indent.

The briefs under the headings are Markdown comments: visible in the editor and to the AI assistant, never on the page or in the PDF.

## What Markdown gives you here

- **Block quotations.** A line starting with `>` sets a quotation of 40 words or more as a block, without quotation marks.
- **Footnotes** with `[^1]`, printed at the foot of the page.
- **Headings** at the levels APA 7 uses, set by the theme.

## What it doesn't do

You write the in-text citations, such as (Author, Year), and the reference list by hand. markoto doesn't format citations from a database and doesn't check APA rules for you. Ask your instructor if a layout detail in the theme differs from what the course requires; you can change fonts, margins and the header in the document theme.

## Who it's for

Students writing a course essay or a short paper in APA 7, in English or in German (the template exists in both). Share the link for peer review: anyone with edit access can comment on a passage.

## Questions

::faq{json-ld}
---
items:
  - q: Is this the APA 7 student paper format?
    a: It follows the structure of an APA 7 student paper: a title page with name, affiliation, course and instructor, double-spaced text, Level 1 headings and a reference list with a hanging indent. Check the details against your instructor's requirements.
  - q: Does markoto format my citations?
    a: No. You write the in-text citations and the reference list by hand. There is no citation database or style engine.
  - q: Can a classmate comment on my draft?
    a: Yes. Anyone with edit access to the document can comment on a passage. Share the link with edit access, then resolve the threads as you work through them.
  - q: Can I write the essay in German?
    a: Yes. The template exists in English and German; pick the document language in the new-document dialog.
---
::

::cta{title="An APA essay that comes out as pages." label="Use this template" template="essay"}
Free on markoto.app, no sign-up needed.
::
