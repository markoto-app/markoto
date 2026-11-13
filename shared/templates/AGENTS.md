# Document templates

What a template is, how it renders and seeds, and how to add one: [`docs/contributing/templates.md`](../../docs/contributing/templates.md). Design (theme preset) work: [`docs/contributing/TEMPLATE-WORKFLOW.md`](../../docs/contributing/TEMPLATE-WORKFLOW.md).

## Rules

- **Keep `index.ts` client-safe.** It is imported by the browser bundle. Never read the `.md` files from `shared/`: Vite's `?raw` works in the client and Vitest but not in Nitro's build. Template text is read only by `server/utils/documents/templateRenderer.ts` (`fs.readFileSync` relative to the working directory).
- **Never rename or remove a template id.** It is stored on documents. Retire it by adding an entry to `TEMPLATE_ALIASES` that points at its replacement.
- **Every template ships `en.md` and `de.md`** (German without `ß`), and every built-in design needs at least one template. `tests/unit/documents/templates.test.ts` pins both.
- **A design that prints the title on its cover or title block gets no leading `# {{title}}`** in the text (pinned).
- **`{{title}}` and `{{description}}` are the only placeholders.** Don't add template logic.
- **Changing a template's text, design or cover placeholders needs a new picture** (`make template-thumbs URL=… IDS=<id>`); `tests/unit/theme/templateThumbnails.test.ts` fails otherwise.
- **The body travels on the token response (`initialBody`), not on `POST /api/docs`**, and the editor seeds it only after the first sync into an empty text. Don't seed elsewhere.
- **The Demo text names real UI labels per locale** (menu paths, button names). When such a label changes, update the demo files too.
