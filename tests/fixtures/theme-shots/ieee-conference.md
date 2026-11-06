<!--
  Fixture: ieee-conference — template "IEEE conference paper", a Markdown twin
  of bare_conf.tex (IEEEtran 1.8b, LPPL) extended with the elements the class
  styles but bare_conf leaves commented out: index terms, a table with its
  caption above, a figure, a list, a footnote, numeric references.
  Reference: compile the same content with IEEEtran.cls (docs/TEMPLATE-WORKFLOW.md).
  Title: "Bare Demo of IEEEtran.cls for IEEE Conferences".
  Patch: ieee-conference-patch.json (three author blocks).
-->

# Abstract

The abstract goes here. It states the problem, the approach and the main result in a single paragraph of no more than about two hundred words, and it does not cite references or use abbreviations that are defined later.

*Index Terms*—IEEE, IEEEtran, conference, paper, template, typesetting.

# Introduction

This demo file is intended to serve as a “starter file” for IEEE conference papers produced under LaTeX using IEEEtran.cls version 1.8b and later. I wish you the best of success.

Conference papers follow a strict format: a letter-size page, two columns of ten-point Times, section headings in small capitals with Roman numerals and subsection headings in italics. The title spans both columns; the authors and their affiliations are set in blocks next to each other below it, and the abstract opens the first column.

The format leaves little room for decoration. Tables are numbered with Roman numerals and captioned above, figures are numbered with Arabic numerals and captioned below, and references are listed in the order in which they are first cited [1].

## Subsection Heading Here

Subsection text here. The class sets its main text sizes as follows:

- the body text in ten-point type on a twelve-point leading;
- the abstract and index terms in nine-point bold type;
- table text, captions and references in eight-point type.

Table I lists the font sizes that the class uses for the elements of the title.

Font Sizes of the Title Elements
{.table-caption}

| Element | Size (pt) | Leading (pt) |
|---|---:|---:|
| Title | 24 | 28 |
| Author name | 11 | 13.4 |
| Affiliation | 10 | 12 |
| Abstract | 9 | 10 |

### Subsubsection Heading Here

Subsubsection text here. Run-in headings like this one belong to the paragraph that follows them.[^1]

# Results

Fig. 1 shows a bar chart. The figure is centred in the column and its caption follows it; a caption that is shorter than one line is centred as well.

![Simulation results for the network.](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAADcEAAAAADd4PFoAAADdklEQVR42u3dsW0aUQCA4SNymw1SxRtkBlYIrTuU1kqXBVJF9gq0zECTNkU8QVx5gwxAmpSJjOHM8cP31dzde6BfD6Gnx2y7HYCoN1MPANifgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhbOSAn65vZ0/XU08KLsXVuLf79ng/DI93U88KLoSv0BAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCEjXwmFryOxeIYT1mvp57nS1mBIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwvw7Ify1XG42+189n08xZiswhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCE2Yl1oMXiGE9Zr6eeJ6fJCgxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmDOxLpBzvM6HFRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMLsxApYLjeb/a+ez6ceP6/HCgxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEntRPLWU3wMlZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIO6mdWJwP53gdhxUYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCLm4nlh1CnBMrMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAi7Gvd2v2+G1ffhdrbn5R+nfjue84+ZGbMx/2/MB/n8/t2v5181csA/V8PwMDzsefXJf0bDvTEb885jPtDj3Q4vmm23Yz7zx9dPXz7cvF2NPRe4NLutwCMHDByTH7EgTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAI+wN30DW8LT8FxgAAAABJRU5ErkJggg==){width=240}

The values in the chart come from a simulation that we repeated ten times with different random seeds [2]. The differences between the runs were below one percent, so the chart shows the mean of all runs.

# Conclusion

The conclusion goes here.

# Acknowledgment {.unnumbered}

The authors would like to thank...

# References {.unnumbered}

1. H. Kopka and P. W. Daly, *A Guide to LaTeX*, 3rd ed. Harlow, England: Addison-Wesley, 1999.
2. M. Shell, “How to use the IEEEtran LaTeX class,” *J. of LaTeX Class Files*, vol. 14, no. 8, pp. 1–15, Aug. 2015.
3. L. Lamport, *LaTeX: A Document Preparation System*, 2nd ed. Reading, MA, USA: Addison-Wesley, 1994.
{.references}

[^1]: A footnote is set in eight-point type at the bottom of the column.
