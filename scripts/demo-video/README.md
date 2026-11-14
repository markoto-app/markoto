# Demo video

The two-minute product video played on `/demo` (hosted marketing site only)
and linked from the README: 1920×1080, H.264 High, yuv420p, AAC, faststart,
under 10 MB so GitHub accepts it as an attachment. The build writes the cut to
`tests/e2e/output/demo-video/markoto-demo.mp4` (not committed), copies it with
its poster and captions to `public/media/` under content-hashed names, writes
`shared/media/demoVideo.ts`, which the `/demo` page reads, and updates the
README poster `.github/media/markoto-demo-poster.webp`. The music is taken
from the committed copy in `public/media/`.

After a new cut, upload the video to GitHub as an attachment (drop it into a
comment box, do not post) and put the new `github.com/user-attachments/...`
link into the README; once markoto.app is live the README links `/demo`.

```sh
bun run demo:video                  # cut the video from the recorded footage
bun run demo:video --capture        # record the footage first, then cut
bun run demo:video --review <dir>   # also put a copy + a contact sheet (a frame every 4 s) in <dir>
```

Needs ffmpeg with `libx264` (point `FFMPEG` at such a build if the one on
`PATH` has only OpenH264, as Fedora's does) and Playwright's Chromium
(`bunx playwright install chromium`).

## How it is made

| File | What |
|---|---|
| `edl.ts` | The edit decision list: every segment's start on the music, card texts, which footage window plays. Change the cut here. |
| `cards.ts` | The cards (chapter titles, terminal cards, end card), the browser window around the footage and the poster, as HTML in the brand fonts and colours. Each page exposes `__render(t)`, so every frame is a deterministic screenshot. |
| `build.ts` | Renders the cards, maps footage frames onto each slot (sped up or slowed down evenly), encodes one intermediate per segment, joins them and encodes the final file in two passes to the size budget. |

- **Music:** the audio track of the committed video, copied bit for bit
  (Andrii Poradovskyi via Pixabay, credited in `NOTICE`). The segment
  start times in `edl.ts` sit on its breaks and drops; keep them when you
  change the content of a segment.
- **Footage:** the product-tour recorder (`tests/e2e/tour/fixture.ts`):
  the tour's scenes (`tests/e2e/tour/*.capture.ts`, light mode) plus the
  video-only scenes in `tests/e2e/demo-video/*.capture.ts` (the template
  picker). Frames land in `tests/e2e/output/demo-video/footage/`
  (`DEMO_VIDEO_FOOTAGE_DIR` moves it); the product page's `public/tour/`
  is not touched.
- **Facts on cards** are checked against the product: the MCP tool count
  is counted from `server/mcp/tools/` at build time; the clone URL is
  `REPO_URL` in `edl.ts`.

## Recording the footage

`--capture` needs the flow test stack and an app in the hosted shape, as
for `bun run tour:capture` (`docs/contributing/flow-docs.md` → Product-tour
captures):

- the flow stack and app with AI as on markoto.app (a chat default only):
  `FLOWS_SERVE_ONLY=1 FLOWS_HOSTED_AI=1 bun run flows:test`
  (`TEST_FAKE_OPENAI_HOST` / `CONTAINER_HOST_ADDRESS` set as in
  `docs/contributing/CONTAINER-ENGINES.md`). Without `FLOWS_HOSTED_AI` the
  editor shows an AI-points meter the hosted service doesn't, and the AI
  scenes fail on it;
- `MISTRAL_API_KEY`, `JINA_AI_API_KEY` and `BFL_API_KEY` in the shell and
  the stack's LiteLLM (the AI scenes are skipped without them).

Watch the result before committing it: the contact sheet shows stale UI,
empty or loading states and cards out of place at a glance.
